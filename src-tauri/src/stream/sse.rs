use crate::error::{AppError, AppResult};

#[derive(Default)]
pub struct SseParser {
    buffer: Vec<u8>,
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some((index, delimiter_len)) = find_boundary(&self.buffer) {
            let event = self.buffer[..index].to_vec();
            self.buffer.drain(..index + delimiter_len);
            if let Some(data) = parse_event(&event) {
                events.push(data);
            }
        }
        events
    }

    pub fn finish(&mut self) -> Option<String> {
        if self.buffer.is_empty() {
            return None;
        }
        let remaining = std::mem::take(&mut self.buffer);
        parse_event(&remaining)
    }
}

fn find_boundary(bytes: &[u8]) -> Option<(usize, usize)> {
    let lf = bytes
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|i| (i, 2));
    let crlf = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|i| (i, 4));
    match (lf, crlf) {
        (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

fn parse_event(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let data = text
        .lines()
        .filter_map(|line| line.trim_end_matches('\r').strip_prefix("data:"))
        .map(|line| line.strip_prefix(' ').unwrap_or(line))
        .collect::<Vec<_>>()
        .join("\n");
    (!data.is_empty()).then_some(data)
}

/// A single provider event. Reasoning parts contain incremental text, while
/// usage is the latest total reported by the provider (never an estimate).
#[derive(Debug, Default)]
pub struct StreamDelta {
    pub done: bool,
    pub text: Option<String>,
    pub reasoning: crate::models::Reasoning,
}

pub fn openai_delta(data: &str) -> AppResult<StreamDelta> {
    if data.trim() == "[DONE]" {
        return Ok(StreamDelta::default());
    }
    let value = parse_json(data)?;
    let delta = value.pointer("/choices/0/delta");
    let mut result = StreamDelta {
        text: value
            .pointer("/choices/0/delta/content")
            .or_else(|| value.pointer("/choices/0/text"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        ..Default::default()
    };
    result.reasoning.tokens = value
        .pointer("/usage/completion_tokens_details/reasoning_tokens")
        .and_then(serde_json::Value::as_u64);
    if let Some(details) = delta
        .and_then(|d| d.get("reasoning_details"))
        .and_then(serde_json::Value::as_array)
    {
        for (position, detail) in details.iter().enumerate() {
            let (kind, field) = match detail.get("type").and_then(serde_json::Value::as_str) {
                Some("reasoning.summary") => ("summary", "summary"),
                Some("reasoning.text") => ("text", "text"),
                Some("reasoning.encrypted") => {
                    result.reasoning.encrypted = true;
                    continue;
                }
                _ => continue,
            };
            if let Some(text) = detail
                .get(field)
                .and_then(serde_json::Value::as_str)
                .filter(|s| !s.is_empty())
            {
                // Index remains stable even when an id is only present in the first chunk.
                let index = detail
                    .get("index")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(position as u64);
                result.reasoning.parts.push(crate::models::ReasoningPart {
                    include_next: false,
                    id: format!("chat-{kind}-{index}"),
                    kind: kind.into(),
                    text: text.into(),
                });
            }
        }
    }
    // OpenRouter may send the same text in both fields. Prefer typed details.
    if result.reasoning.parts.is_empty() {
        if let Some(text) = delta
            .and_then(|d| {
                d.get("reasoning_content")
                    .and_then(serde_json::Value::as_str)
                    .filter(|s| !s.is_empty())
                    .or_else(|| d.get("reasoning").and_then(serde_json::Value::as_str))
            })
            .filter(|s| !s.is_empty())
        {
            result.reasoning.parts.push(crate::models::ReasoningPart {
                include_next: true,
                id: "chat-reasoning".into(),
                kind: "text".into(),
                text: text.into(),
            });
        }
    }
    Ok(result)
}

fn parse_json(data: &str) -> AppResult<serde_json::Value> {
    let value: serde_json::Value = serde_json::from_str(data)
        .map_err(|error| AppError::Message(format!("invalid SSE JSON: {error}")))?;
    if let Some(error) = value.get("error").filter(|e| !e.is_null()) {
        return Err(AppError::Message(format!("provider stream error: {error}")));
    }
    Ok(value)
}

/// Tracks parts so `.done` / completed snapshots can supply missing text without
/// duplicating deltas. Also keeps separate summary parts and output items apart.
#[derive(Default)]
pub struct ResponsesDecoder {
    seen: std::collections::HashMap<String, String>,
}

impl ResponsesDecoder {
    fn part(
        &mut self,
        result: &mut StreamDelta,
        id: String,
        kind: &str,
        text: &str,
        snapshot: bool,
    ) {
        let previous = self.seen.entry(id.clone()).or_default();
        let addition = if snapshot {
            // Some endpoints only return reasoning in the final item snapshot.
            text.strip_prefix(previous.as_str()).unwrap_or("")
        } else {
            text
        };
        if !addition.is_empty() {
            result.reasoning.parts.push(crate::models::ReasoningPart {
                include_next: kind == "text",
                id,
                kind: kind.into(),
                text: addition.into(),
            });
            previous.push_str(addition);
        }
    }

    fn item(&mut self, result: &mut StreamDelta, item: &serde_json::Value, fallback_id: &str) {
        if item.get("type").and_then(serde_json::Value::as_str) != Some("reasoning") {
            return;
        }
        let id = item
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(fallback_id);
        result.reasoning.encrypted |= item
            .get("encrypted_content")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|s| !s.is_empty());
        for (field, kind) in [("summary", "summary"), ("content", "text")] {
            if let Some(parts) = item.get(field).and_then(serde_json::Value::as_array) {
                for (index, part) in parts.iter().enumerate() {
                    if let Some(text) = part.get("text").and_then(serde_json::Value::as_str) {
                        self.part(result, format!("{id}-{kind}-{index}"), kind, text, true);
                    }
                }
            }
        }
    }

    pub fn decode(&mut self, data: &str) -> AppResult<StreamDelta> {
        let value = parse_json(data)?;
        let mut result = StreamDelta::default();
        let event_type = value
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        match event_type {
            "error" => {
                return Err(AppError::Message(format!(
                    "provider stream error: {}",
                    value
                        .get("message")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("unknown Responses API error")
                )))
            }
            "response.failed" => {
                return Err(AppError::Message(format!(
                    "provider stream error: {}",
                    value
                        .pointer("/response/error/message")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("Responses API request failed")
                )))
            }
            "response.output_text.delta" | "response.refusal.delta" => {
                result.text = value
                    .get("delta")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
            }
            "response.reasoning_summary_text.delta"
            | "response.reasoning_text.delta"
            | "response.reasoning_summary_text.done"
            | "response.reasoning_text.done" => {
                let summary = event_type.contains("summary");
                let kind = if summary { "summary" } else { "text" };
                let snapshot = event_type.ends_with(".done");
                let index = value
                    .get(if summary {
                        "summary_index"
                    } else {
                        "content_index"
                    })
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                let item = value
                    .get("item_id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        value
                            .get("output_index")
                            .unwrap_or(&serde_json::Value::Null)
                            .to_string()
                    });
                if let Some(text) = value
                    .get(if snapshot { "text" } else { "delta" })
                    .and_then(serde_json::Value::as_str)
                {
                    self.part(
                        &mut result,
                        format!("{item}-{kind}-{index}"),
                        kind,
                        text,
                        snapshot,
                    );
                }
            }
            "response.output_item.done" => {
                if let Some(item) = value.get("item") {
                    self.item(
                        &mut result,
                        item,
                        &value
                            .get("output_index")
                            .unwrap_or(&serde_json::Value::Null)
                            .to_string(),
                    );
                }
            }
            "response.completed" | "response.incomplete" => {
                result.done = true;
                result.reasoning.tokens = value
                    .pointer("/response/usage/output_tokens_details/reasoning_tokens")
                    .and_then(serde_json::Value::as_u64);
                if let Some(items) = value
                    .pointer("/response/output")
                    .and_then(serde_json::Value::as_array)
                {
                    for (index, item) in items.iter().enumerate() {
                        self.item(&mut result, item, &index.to_string());
                    }
                }
            }
            _ => {}
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::{openai_delta, ResponsesDecoder, SseParser};
    use crate::models::Reasoning;

    #[test]
    fn separates_chat_reasoning_from_answers_and_usage_only_chunks() {
        let delta = openai_delta(
            r#"{"choices":[{"delta":{"content":"answer","reasoning_content":"考え中"}}]}"#,
        )
        .unwrap();
        assert_eq!(delta.text.as_deref(), Some("answer"));
        assert_eq!(delta.reasoning.parts[0].text, "考え中");
        assert_eq!(delta.reasoning.parts[0].kind, "text");
        assert!(delta.reasoning.parts[0].include_next);
        let alias = openai_delta(
            r#"{"choices":[{"delta":{"reasoning_content":null,"reasoning":"thinking"}}]}"#,
        )
        .unwrap();
        assert_eq!(alias.reasoning.parts[0].text, "thinking");
        let usage = openai_delta(
            r#"{"choices":[],"usage":{"completion_tokens_details":{"reasoning_tokens":42}}}"#,
        )
        .unwrap();
        assert_eq!(usage.reasoning.tokens, Some(42));
        assert!(usage.text.is_none());
        assert!(
            openai_delta(r#"{"choices":[{"delta":{"content":"plain"}}]}"#)
                .unwrap()
                .reasoning
                .is_empty()
        );
        assert!(openai_delta(r#"{"error":{"message":"failed"}}"#).is_err());
    }

    #[test]
    fn prefers_typed_details_without_exposing_encrypted_data_or_signatures() {
        let delta = openai_delta(
            r#"{"choices":[{"delta":{"reasoning":"duplicate","reasoning_details":[
            {"type":"reasoning.summary","summary":"overview","index":0},
            {"type":"reasoning.text","text":"steps","signature":"secret","index":1},
            {"type":"reasoning.encrypted","data":"secret","index":2}
        ]}}]}"#,
        )
        .unwrap();
        assert_eq!(delta.reasoning.parts.len(), 2);
        assert_eq!(delta.reasoning.parts[0].kind, "summary");
        assert_eq!(delta.reasoning.parts[1].text, "steps");
        assert!(delta.reasoning.encrypted);
        let json = serde_json::to_string(&delta.reasoning).unwrap();
        assert!(!json.contains("secret"));
        assert!(!json.contains("duplicate"));
    }

    #[test]
    fn reconciles_responses_snapshots_and_keeps_parts_separate() {
        let events = [
            r#"{"type":"response.reasoning_summary_text.delta","item_id":"rs","summary_index":0,"delta":"First"}"#,
            r#"{"type":"response.reasoning_summary_text.done","item_id":"rs","summary_index":0,"text":"First summary"}"#,
            r#"{"type":"response.reasoning_summary_text.delta","item_id":"rs","summary_index":1,"delta":"Second"}"#,
            r#"{"type":"response.reasoning_text.delta","item_id":"rs","content_index":0,"delta":"Raw"}"#,
            r#"{"type":"response.output_item.done","item":{"id":"rs","type":"reasoning","summary":[{"type":"summary_text","text":"First summary"},{"type":"summary_text","text":"Second"}],"content":[{"type":"reasoning_text","text":"Raw"}],"encrypted_content":"secret"}}"#,
            r#"{"type":"response.completed","response":{"output":[{"id":"rs","type":"reasoning","summary":[{"type":"summary_text","text":"First summary"},{"type":"summary_text","text":"Second"}]}],"usage":{"output_tokens_details":{"reasoning_tokens":99}}}}"#,
        ];
        let mut decoder = ResponsesDecoder::default();
        let mut reasoning = Reasoning::default();
        for event in events {
            reasoning.merge(&decoder.decode(event).unwrap().reasoning);
        }
        assert_eq!(reasoning.parts.len(), 3);
        assert_eq!(reasoning.parts[0].text, "First summary");
        assert_eq!(reasoning.parts[1].text, "Second");
        assert_eq!(reasoning.parts[2].text, "Raw");
        assert!(reasoning.encrypted);
        assert_eq!(reasoning.tokens, Some(99));
    }

    #[test]
    fn accepts_final_only_reasoning_and_incomplete_usage() {
        let mut decoder = ResponsesDecoder::default();
        let delta = decoder.decode(r#"{"type":"response.incomplete","response":{"output":[{"id":"rs","type":"reasoning","summary":[{"type":"summary_text","text":"Final summary"}]}],"usage":{"output_tokens_details":{"reasoning_tokens":12}}}}"#).unwrap();
        assert!(delta.done);
        assert_eq!(delta.reasoning.parts[0].text, "Final summary");
        assert_eq!(delta.reasoning.tokens, Some(12));
    }

    #[test]
    fn parses_fragmented_events() {
        let mut parser = SseParser::default();
        assert!(parser
            .push(b"data: {\"choices\":[{\"delta\":{\"content\":\"he")
            .is_empty());
        let events = parser.push(b"llo\"}}]}\n\ndata: [DONE]\n\n");
        assert_eq!(events.len(), 2);
        assert_eq!(
            openai_delta(&events[0]).unwrap().text.as_deref(),
            Some("hello")
        );
        assert_eq!(openai_delta(&events[1]).unwrap().text, None);
    }

    #[test]
    fn parses_responses_text_and_refusal_deltas() {
        assert_eq!(
            ResponsesDecoder::default()
                .decode(r#"{"type":"response.output_text.delta","delta":"hello"}"#)
                .unwrap()
                .text
                .as_deref(),
            Some("hello")
        );
        assert_eq!(
            ResponsesDecoder::default()
                .decode(r#"{"type":"response.refusal.delta","delta":"sorry"}"#)
                .unwrap()
                .text
                .as_deref(),
            Some("sorry")
        );
    }

    #[test]
    fn surfaces_responses_failures() {
        assert!(ResponsesDecoder::default()
            .decode(r#"{"type":"error","code":"bad_request","message":"nope"}"#)
            .is_err());
        assert!(ResponsesDecoder::default()
            .decode(r#"{"type":"response.failed","response":{"error":{"message":"failed"}}}"#)
            .is_err());
    }
}
