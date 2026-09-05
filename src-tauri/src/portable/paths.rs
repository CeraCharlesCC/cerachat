use std::path::PathBuf;

use crate::error::{AppError, AppResult};

pub fn data_dir() -> AppResult<PathBuf> {
    let dir = if let Ok(path) = std::env::var("CERACHAT_DATA_DIR") {
        PathBuf::from(path)
    } else {
        let exe = std::env::current_exe()?;
        exe.parent()
            .ok_or_else(|| AppError::Message("cannot determine executable directory".into()))?
            .join("data")
    };
    std::fs::create_dir_all(&dir)?;
    std::fs::create_dir_all(dir.join("cache"))?;
    std::fs::create_dir_all(dir.join("logs"))?;
    Ok(dir)
}
