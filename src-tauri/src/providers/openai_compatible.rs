use futures_util::StreamExt;
use reqwest::Client;

use crate::{
    error::{AppError, AppResult},
    models::ProviderConfig,
    stream::sse::{openai_delta, responses_delta, SseParser},
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

pub async fn stream_once<F>(
    provider: &ProviderConfig,
    request_json: String,
    mut on_delta: F,
) -> AppResult<String>
where
    F: FnMut(&str) -> AppResult<()>,
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
        return Err(AppError::Message(format!(
            "provider returned {status}: {short}"
        )));
    }

    let mut bytes = response.bytes_stream();
    let mut parser = SseParser::default();
    let mut output = String::new();
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
                responses_delta(&data)?
            } else {
                openai_delta(&data)?
            };
            if let Some(delta) = delta {
                output.push_str(&delta);
                on_delta(&delta)?;
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
                    responses_delta(&data)?
                } else {
                    openai_delta(&data)?
                };
                if let Some(delta) = delta {
                    output.push_str(&delta);
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
    use super::{endpoint, responses_endpoint};

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
