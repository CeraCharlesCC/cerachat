use std::path::Path;

use chardetng::EncodingDetector;

use crate::error::{AppError, AppResult};
use super::index::TextIndex;

pub const TEXT_EXTENSIONS: &[&str] = &["txt", "md", "json", "log", "csv"];

pub fn is_supported_text_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| TEXT_EXTENSIONS.iter().any(|ext| value.eq_ignore_ascii_case(ext)))
        .unwrap_or(false)
}

pub fn decode_text(bytes: &[u8]) -> AppResult<String> {
    if bytes.is_empty() {
        return Ok(String::new());
    }

    let mut detector = EncodingDetector::new();
    detector.feed(bytes, true);
    let encoding = detector.guess(None, true);
    let (decoded, _, had_errors) = encoding.decode(bytes);
    if had_errors && encoding == encoding_rs::UTF_8 {
        return Err(AppError::Message("text contains invalid UTF-8 sequences".into()));
    }
    Ok(decoded.into_owned().trim_start_matches('\u{feff}').to_string())
}

pub fn line_count(text: &str) -> i64 {
    TextIndex::build(text).line_count(text) as i64
}

pub fn estimate_tokens(text: &str) -> u64 {
    let chars = text.chars().count() as u64;
    (chars + 3) / 4
}

pub fn slice_text(
    text: &str,
    range_type: &str,
    start_pos: Option<i64>,
    end_pos: Option<i64>,
) -> AppResult<String> {
    match range_type {
        "all" => Ok(text.to_string()),
        "lines" => {
            let start = start_pos.unwrap_or(1).max(1) as usize;
            let end = end_pos.unwrap_or(start as i64).max(start as i64) as usize;
            let index = TextIndex::build(text);
            let (start_byte, end_byte) = index
                .byte_range_for_lines(text, start, end)
                .ok_or_else(|| AppError::Message("line range is outside the source".into()))?;
            Ok(text[start_byte..end_byte].to_string())
        }
        "chars" => {
            let chars: Vec<char> = text.chars().collect();
            let start = start_pos.unwrap_or(0).max(0) as usize;
            let end = end_pos.unwrap_or(chars.len() as i64).max(start as i64) as usize;
            if start > chars.len() {
                return Err(AppError::Message("character range starts past end of source".into()));
            }
            Ok(chars[start..end.min(chars.len())].iter().collect())
        }
        other => Err(AppError::Message(format!("unsupported range type: {other}"))),
    }
}
