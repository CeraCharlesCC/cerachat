use std::{fs, path::Path};

use serde::{Deserialize, Serialize};

use crate::{error::{AppError, AppResult}, models::ProviderConfig};

#[derive(Debug, Default, Serialize, Deserialize)]
struct SecretFile {
    api_key: String,
}

pub fn load(data_dir: &Path) -> AppResult<ProviderConfig> {
    let settings_path = data_dir.join("settings.json");
    let secrets_path = data_dir.join("secrets.json");
    let mut provider = if settings_path.exists() {
        serde_json::from_slice::<ProviderConfig>(&fs::read(&settings_path)?)?
    } else {
        ProviderConfig::default()
    };
    if provider.api_key_storage == "plain_portable" && secrets_path.exists() {
        let secrets: SecretFile = serde_json::from_slice(&fs::read(secrets_path)?)?;
        provider.api_key = secrets.api_key;
    }
    Ok(provider)
}

pub fn save(data_dir: &Path, provider: &ProviderConfig) -> AppResult<()> {
    if provider.api_key_storage != "plain_portable" {
        return Err(AppError::Message(
            "Windows DPAPI storage is not enabled in this v1 build; choose Plain portable configuration".into(),
        ));
    }
    let mut public = provider.clone();
    public.api_key.clear();
    write_atomic(&data_dir.join("settings.json"), &serde_json::to_vec_pretty(&public)?)?;
    let secret = SecretFile { api_key: provider.api_key.clone() };
    write_atomic(&data_dir.join("secrets.json"), &serde_json::to_vec_pretty(&secret)?)?;
    Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let temp = path.with_extension("tmp");
    fs::write(&temp, bytes)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(temp, path)?;
    Ok(())
}
