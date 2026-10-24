use futures_util::{
    future::{AbortRegistration, Abortable},
    StreamExt,
};
use reqwest::Client;

use crate::{
    error::{AppError, AppResult},
    models::{ProviderConfig, Reasoning},
    stream::sse::{openai_delta, ResponsesDecoder, SseParser, StreamDelta},
};

fn api_root(base_url: &str) -> &str {
    let base = base_url.trim_end_matches('/');
    base.strip_suffix("/chat/completions")
        .or_else(|| base.strip_suffix("/responses"))
        .unwrap_or(base)
}

pub fn endpoint(base_url: &str) -> String {
    format!("{}/chat/completions", api_root(base_url))
}

pub fn responses_endpoint(base_url: &str) -> String {
    format!("{}/responses", api_root(base_url))
}

#[derive(Default)]
pub struct ProviderOutput {
    pub content: String,
    pub reasoning: Reasoning,
}

impl ProviderOutput {
    fn merge(&mut self, delta: &StreamDelta) {
        if let Some(text) = &delta.text {
            self.content.push_str(text);
        }
        self.reasoning.merge(&delta.reasoning);
    }
}

pub async fn stream_cancellable<F>(
    provider: &ProviderConfig,
    request_json: String,
    registration: AbortRegistration,
    mut on_delta: F,
) -> AppResult<(ProviderOutput, bool)>
where
    F: FnMut(&StreamDelta) -> AppResult<()>,
{
    let mut partial = ProviderOutput::default();
    let result = Abortable::new(
        stream_once(provider, request_json, |delta| {
            partial.merge(delta);
            on_delta(delta)
        }),
        registration,
    )
    .await;
    // Aborting drops the HTTP future even while headers or the next chunk are
    // pending. Preserve the content already delivered to the caller.
    match result {
        Ok(output) => output.map(|output| (output, false)),
        Err(_) => Ok((partial, true)),
    }
}

pub async fn stream_once<F>(
    provider: &ProviderConfig,
    request_json: String,
    mut on_delta: F,
) -> AppResult<ProviderOutput>
where
    F: FnMut(&StreamDelta) -> AppResult<()>,
{
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .build()?;
    let is_responses = match provider.protocol.as_str() {
        "openai_chat_completions" => false,
        "openai_responses" => true,
        other => {
            return Err(AppError::Message(format!(
                "unsupported provider protocol: {other}"
            )))
        }
    };
    let has_images = request_json.contains("\"image_url\"");
    let mut request = client
        .post(if is_responses {
            responses_endpoint(&provider.base_url)
        } else {
            endpoint(&provider.base_url)
        })
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(request_json);
    if !provider.api_key.is_empty() {
        request = request.bearer_auth(&provider.api_key);
    }

    // Deliberately exactly one outbound request. No probes, retries, tools, or continuations.
    let response = request.send().await?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let short: String = body.chars().take(4096).collect();
        let hint = if has_images && matches!(status.as_u16(), 400 | 413 | 415 | 422) {
            " Image input was included. Check this service/model's image support, formats, size and count limits. Adjust Provider settings or exclude image messages before explicitly retrying."
        } else {
            ""
        };
        return Err(AppError::Message(format!(
            "provider returned {status}: {short}{hint}"
        )));
    }

    let mut bytes = response.bytes_stream();
    let mut parser = SseParser::default();
    let mut output = ProviderOutput::default();
    let mut decoder = ResponsesDecoder::default();
    let mut saw_done = false;
    let mut saw_event = false;

    while let Some(chunk) = bytes.next().await {
        for data in parser.push(&chunk?) {
            saw_event = true;
            if data.trim() == "[DONE]" {
                saw_done = true;
                break;
            }
            let delta = if is_responses {
                decoder.decode(&data)?
            } else {
                openai_delta(&data)?
            };
            output.merge(&delta);
            if delta.text.is_some() || !delta.reasoning.is_empty() {
                on_delta(&delta)?;
            }
            if delta.done {
                saw_done = true;
                break;
            }
        }
        if saw_done {
            break;
        }
    }

    if !saw_done {
        if let Some(data) = parser.finish() {
            saw_event = true;
            if data.trim() != "[DONE]" {
                let delta = if is_responses {
                    decoder.decode(&data)?
                } else {
                    openai_delta(&data)?
                };
                output.merge(&delta);
                if delta.text.is_some() || !delta.reasoning.is_empty() {
                    on_delta(&delta)?;
                }
            }
        }
    }

    if !saw_event {
        return Err(AppError::Message(
            "provider response was not an SSE stream".into(),
        ));
    }

    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::{endpoint, responses_endpoint, stream_cancellable};
    use crate::models::ProviderConfig;
    use futures_util::future::AbortHandle;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        time::Duration,
    };

    #[test]
    fn cancellation_closes_pending_http_and_preserves_received_content() {
        for with_content in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base_url = format!("http://{}", listener.local_addr().unwrap());
            let (handle, registration) = AbortHandle::new_pair();
            let server_handle = handle.clone();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = Vec::new();
                let mut byte = [0];
                while !request.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                if with_content {
                    let event = "data: {\"choices\":[{\"delta\":{\"content\":\"partial answer\",\"reasoning_content\":\"thinking\"}}]}\n\n";
                    write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n", event.len(), event).unwrap();
                    socket.flush().unwrap();
                } else {
                    // Cancel while the client is still awaiting response headers.
                    server_handle.abort();
                }
                // Cancellation must close the connection without a final chunk.
                socket.read_to_end(&mut Vec::new()).unwrap();
                listener.set_nonblocking(true).unwrap();
                assert!(listener.accept().is_err(), "cancellation must not retry");
            });
            let provider = ProviderConfig {
                image_input: false,
                id: "test".into(),
                name: "Test".into(),
                protocol: "openai_chat_completions".into(),
                base_url,
                api_key: String::new(),
                api_key_storage: "plain_portable".into(),
                model: "test".into(),
                context_window: 8192,
                max_output_tokens: 1024,
                system_text: String::new(),
                temperature: None,
                raw_json_overrides: "{}".into(),
                context_separator: String::new(),
            };
            let runtime = tokio::runtime::Runtime::new().unwrap();
            let (output, cancelled) = runtime
                .block_on(stream_cancellable(
                    &provider,
                    "{}".into(),
                    registration,
                    |_| {
                        handle.abort();
                        Ok(())
                    },
                ))
                .unwrap();
            assert!(cancelled);
            if with_content {
                assert_eq!(output.content, "partial answer");
                assert_eq!(output.reasoning.parts[0].text, "thinking");
            } else {
                assert!(output.content.is_empty());
                assert!(output.reasoning.is_empty());
            }
            server.join().unwrap();
        }
    }

    #[test]
    fn rejected_image_requests_preserve_the_exact_body_and_do_not_retry_without_images() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let request_json = serde_json::json!({
            "model": "arbitrary-model", "stream": true,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": "Describe"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo="}}
            ]}]
        })
        .to_string();
        let expected = request_json.clone();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut headers = Vec::new();
            let mut byte = [0];
            while !headers.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                headers.push(byte[0]);
            }
            let headers = String::from_utf8(headers).unwrap();
            assert!(headers.starts_with("POST /chat/completions "));
            let size: usize = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|value| value.trim().parse().unwrap())
                })
                .unwrap();
            let mut body = vec![0; size];
            socket.read_exact(&mut body).unwrap();
            assert_eq!(String::from_utf8(body).unwrap(), expected);
            let body = r#"{"error":{"message":"Images not supported by this model"}}"#;
            write!(socket, "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            socket.flush().unwrap();
            listener
        });
        let provider = ProviderConfig {
            image_input: true,
            id: "custom".into(),
            name: "Custom".into(),
            protocol: "openai_chat_completions".into(),
            base_url,
            api_key: String::new(),
            api_key_storage: "plain_portable".into(),
            model: "arbitrary-model".into(),
            context_window: 8192,
            max_output_tokens: 1024,
            system_text: String::new(),
            temperature: None,
            raw_json_overrides: "{}".into(),
            context_separator: String::new(),
        };
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(super::stream_once(&provider, request_json, |_| Ok(())));
        let error = result.err().unwrap().to_string();
        assert!(error.contains("400 Bad Request"));
        assert!(error.contains("Images not supported by this model"));
        assert!(error.contains("Image input was included"));
        let listener = server.join().unwrap();
        listener.set_nonblocking(true).unwrap();
        assert!(
            listener.accept().is_err(),
            "failed image input must not trigger a retry"
        );
    }

    #[test]
    fn switches_between_known_openai_endpoints() {
        assert_eq!(
            endpoint("https://api.example.test/v1/responses"),
            "https://api.example.test/v1/chat/completions"
        );
        assert_eq!(
            responses_endpoint("https://api.example.test/v1/chat/completions/"),
            "https://api.example.test/v1/responses"
        );
        assert_eq!(
            responses_endpoint("https://api.example.test/v1"),
            "https://api.example.test/v1/responses"
        );
    }
}
