#[derive(Debug, Clone)]
pub struct TextIndex {
    pub line_offsets: Vec<u64>,
}

impl TextIndex {
    pub fn build(text: &str) -> Self {
        let mut line_offsets = vec![0];
        for (index, byte) in text.bytes().enumerate() {
            if byte == b'\n' {
                line_offsets.push((index + 1) as u64);
            }
        }
        Self { line_offsets }
    }

    pub fn line_count(&self, text: &str) -> usize {
        if text.is_empty() { 0 } else { self.line_offsets.len() }
    }

    pub fn byte_range_for_lines(&self, text: &str, start: usize, end: usize) -> Option<(usize, usize)> {
        let total = self.line_count(text);
        if start == 0 || start > total || end < start {
            return None;
        }
        let clamped_end = end.min(total);
        let start_byte = self.line_offsets[start - 1] as usize;
        let end_byte = if clamped_end < total {
            self.line_offsets[clamped_end] as usize
        } else {
            text.len()
        };
        Some((start_byte, end_byte))
    }
}

#[cfg(test)]
mod tests {
    use super::TextIndex;

    #[test]
    fn indexes_line_starts() {
        let text = "a\nb\n";
        let index = TextIndex::build(text);
        assert_eq!(index.line_offsets, vec![0, 2, 4]);
        assert_eq!(index.line_count(text), 3);
        assert_eq!(index.byte_range_for_lines(text, 1, 2), Some((0, 4)));
    }
}
