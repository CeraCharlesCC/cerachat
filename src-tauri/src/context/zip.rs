use std::{fs::File, io::Read, path::Path};

use crate::error::{AppError, AppResult};

use super::text::{decode_text, is_supported_text_path};

const MAX_TEXT_ENTRY_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug)]
pub struct ZipTextEntry {
    pub archive_path: String,
    pub text: String,
}

pub fn extract_text_entries(path: &Path) -> AppResult<Vec<ZipTextEntry>> {
    let file = File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut entries = Vec::new();

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        if entry.is_dir() || entry.size() > MAX_TEXT_ENTRY_BYTES {
            continue;
        }
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };
        if !is_supported_text_path(&enclosed) {
            continue;
        }

        let mut bytes = Vec::with_capacity(entry.size().min(8 * 1024 * 1024) as usize);
        entry.read_to_end(&mut bytes)?;
        let text = decode_text(&bytes)
            .map_err(|error| AppError::Message(format!("{}: {error}", enclosed.display())))?;
        entries.push(ZipTextEntry {
            archive_path: enclosed.to_string_lossy().replace('\\', "/"),
            text,
        });
    }

    Ok(entries)
}
