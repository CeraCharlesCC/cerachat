pub mod compiler;
pub mod index;
pub mod text;
pub mod zip;

use std::{fs, path::Path};

use crate::{
    db::{context as db_context, Database},
    error::{AppError, AppResult},
    models::WorkspaceSource,
};

pub fn import_paths(db: &Database, paths: &[String]) -> AppResult<Vec<WorkspaceSource>> {
    let mut imported = Vec::new();
    for raw_path in paths {
        let path = Path::new(raw_path);
        if !path.is_file() {
            continue;
        }
        let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default();
        if extension.eq_ignore_ascii_case("zip") {
            let archive_name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("archive.zip");
            for entry in zip::extract_text_entries(path)? {
                let display_name = format!("{archive_name} / {}", entry.archive_path);
                imported.push(db_context::add_source(
                    db,
                    display_name,
                    path.to_string_lossy().to_string(),
                    Some(entry.archive_path),
                    &entry.text,
                )?);
            }
            continue;
        }
        if !text::is_supported_text_path(path) {
            continue;
        }
        let bytes = fs::read(path)?;
        let decoded = text::decode_text(&bytes)?;
        let display_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("source")
            .to_string();
        imported.push(db_context::add_source(
            db,
            display_name,
            path.to_string_lossy().to_string(),
            None,
            &decoded,
        )?);
    }

    if imported.is_empty() {
        return Err(AppError::Message(
            "no supported TXT/MD/JSON/LOG/CSV files were found".into(),
        ));
    }
    Ok(imported)
}
