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

pub fn openai_delta(data: &str) -> AppResult<Option<String>> {
    if data.trim() == "[DONE]" {
        return Ok(None);
    }
    let value: serde_json::Value = serde_json::from_str(data)
        .map_err(|error| AppError::Message(format!("invalid SSE JSON: {error}")))?;
    if let Some(error) = value.get("error") {
        return Err(AppError::Message(format!("provider stream error: {error}")));
    }
    Ok(value
        .pointer("/choices/0/delta/content")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            value
                .pointer("/choices/0/text")
                .and_then(serde_json::Value::as_str)
        })
        .map(str::to_string))
}

pub fn responses_delta(data: &str) -> AppResult<Option<String>> {
    let value: serde_json::Value = serde_json::from_str(data)
        .map_err(|error| AppError::Message(format!("invalid Responses SSE JSON: {error}")))?;
    if let Some(error) = value.get("error") {
        return Err(AppError::Message(format!("provider stream error: {error}")));
    }
    Ok(value
        .get("type")
        .and_then(|kind| kind.as_str())
        .filter(|kind| *kind == "response.output_text.delta")
        .and_then(|_| value.get("delta"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string))
}

#[cfg(test)]
mod tests {
    use super::{openai_delta, SseParser};

    #[test]
    fn parses_fragmented_events() {
        let mut parser = SseParser::default();
        assert!(parser
            .push(b"data: {\"choices\":[{\"delta\":{\"content\":\"he")
            .is_empty());
        let events = parser.push(b"llo\"}}]}\n\ndata: [DONE]\n\n");
        assert_eq!(events.len(), 2);
        assert_eq!(openai_delta(&events[0]).unwrap().as_deref(), Some("hello"));
        assert_eq!(openai_delta(&events[1]).unwrap(), None);
    }
}
