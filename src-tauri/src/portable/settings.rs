use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use serde::{de::MapAccess, Deserialize, Deserializer, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::{ModelProfile, ProviderCatalog, ProviderConfig, ProviderProfile},
};

const SETTINGS_VERSION: u32 = 1;
const SECRETS_VERSION: u32 = 1;
const SETTINGS_FILE: &str = "settings.json";
const LEGACY_SECRETS_FILE: &str = "secrets.json";

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsFile {
    version: u32,
    secret_generation: String,
    #[serde(deserialize_with = "deserialize_nullable")]
    selected_model_id: Option<String>,
    providers: Vec<ProviderProfile>,
    models: Vec<ModelProfile>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SecretFile {
    version: u32,
    generation: String,
    #[serde(deserialize_with = "deserialize_unique_map")]
    api_keys: HashMap<String, String>,
}

struct LoadedCatalog {
    catalog: ProviderCatalog,
    api_keys: HashMap<String, String>,
}

/// Serializes all catalog reads and writes so each operation sees one complete generation.
pub struct SettingsStore {
    data_dir: PathBuf,
    lock: Mutex<()>,
}

struct StoreGuard<'a> {
    _local: MutexGuard<'a, ()>,
    file: File,
}

impl Drop for StoreGuard<'_> {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

impl SettingsStore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            lock: Mutex::new(()),
        }
    }

    pub fn load_catalog(&self) -> AppResult<ProviderCatalog> {
        let _guard = self.guard()?;
        Ok(self.load()?.catalog)
    }

    pub fn load_active_provider(&self) -> AppResult<ProviderConfig> {
        let _guard = self.guard()?;
        resolve_active(self.load()?)
    }

    pub fn save_provider(
        &self,
        provider: ProviderProfile,
        api_key: Option<String>,
    ) -> AppResult<ProviderCatalog> {
        let _guard = self.guard()?;
        let mut loaded = self.load()?;
        validate_provider(&provider)?;
        if let Some(existing) = loaded
            .catalog
            .providers
            .iter_mut()
            .find(|p| p.id == provider.id)
        {
            *existing = provider.clone();
            if let Some(api_key) = api_key {
                loaded.api_keys.insert(provider.id.clone(), api_key);
            }
        } else {
            loaded.catalog.providers.push(provider.clone());
            loaded
                .api_keys
                .insert(provider.id.clone(), api_key.unwrap_or_default());
        }
        persist(&self.data_dir, &loaded.catalog, &loaded.api_keys)?;
        Ok(loaded.catalog)
    }

    pub fn delete_provider(&self, provider_id: &str) -> AppResult<ProviderCatalog> {
        let _guard = self.guard()?;
        let mut loaded = self.load()?;
        let old_len = loaded.catalog.providers.len();
        loaded
            .catalog
            .providers
            .retain(|provider| provider.id != provider_id);
        if loaded.catalog.providers.len() == old_len {
            return Err(AppError::Message(format!(
                "provider '{provider_id}' does not exist"
            )));
        }
        loaded
            .catalog
            .models
            .retain(|model| model.provider_id != provider_id);
        loaded.api_keys.remove(provider_id);
        if loaded
            .catalog
            .selected_model_id
            .as_deref()
            .and_then(split_unique_model_id)
            .is_some_and(|(selected_provider, _)| selected_provider == provider_id)
        {
            loaded.catalog.selected_model_id = None;
        }
        persist(&self.data_dir, &loaded.catalog, &loaded.api_keys)?;
        Ok(loaded.catalog)
    }

    pub fn save_model(&self, model: ModelProfile) -> AppResult<ProviderCatalog> {
        let _guard = self.guard()?;
        let mut loaded = self.load()?;
        validate_model(&model)?;
        if !loaded
            .catalog
            .providers
            .iter()
            .any(|provider| provider.id == model.provider_id)
        {
            return Err(AppError::Message(format!(
                "provider '{}' does not exist",
                model.provider_id
            )));
        }
        if let Some(existing) =
            loaded.catalog.models.iter_mut().find(|item| {
                item.provider_id == model.provider_id && item.model_id == model.model_id
            })
        {
            *existing = model;
        } else {
            loaded.catalog.models.push(model);
        }
        persist(&self.data_dir, &loaded.catalog, &loaded.api_keys)?;
        Ok(loaded.catalog)
    }

    pub fn delete_model(&self, provider_id: &str, model_id: &str) -> AppResult<ProviderCatalog> {
        let _guard = self.guard()?;
        let mut loaded = self.load()?;
        let old_len = loaded.catalog.models.len();
        loaded
            .catalog
            .models
            .retain(|model| model.provider_id != provider_id || model.model_id != model_id);
        if loaded.catalog.models.len() == old_len {
            return Err(AppError::Message(format!(
                "model '{provider_id}::{model_id}' does not exist"
            )));
        }
        if loaded.catalog.selected_model_id.as_deref()
            == Some(&unique_model_id(provider_id, model_id))
        {
            loaded.catalog.selected_model_id = None;
        }
        persist(&self.data_dir, &loaded.catalog, &loaded.api_keys)?;
        Ok(loaded.catalog)
    }

    pub fn select_model(&self, unique_model_id: &str) -> AppResult<ProviderCatalog> {
        let _guard = self.guard()?;
        let mut loaded = self.load()?;
        let (provider_id, model_id) = split_unique_model_id(unique_model_id).ok_or_else(|| {
            AppError::Message("model selection must use the provider_id::model_id format".into())
        })?;
        if !loaded.catalog.providers.iter().any(|p| p.id == provider_id) {
            return Err(AppError::Message(format!(
                "selected provider '{provider_id}' does not exist"
            )));
        }
        if !loaded
            .catalog
            .models
            .iter()
            .any(|model| model.provider_id == provider_id && model.model_id == model_id)
        {
            return Err(AppError::Message(format!(
                "selected model '{unique_model_id}' does not exist"
            )));
        }
        loaded.catalog.selected_model_id = Some(unique_model_id.to_owned());
        persist(&self.data_dir, &loaded.catalog, &loaded.api_keys)?;
        Ok(loaded.catalog)
    }

    fn guard(&self) -> AppResult<StoreGuard<'_>> {
        let local = self
            .lock
            .lock()
            .map_err(|_| AppError::Message("settings lock is poisoned".into()))?;
        fs::create_dir_all(&self.data_dir)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.data_dir.join(".settings.lock"))?;
        file.lock()?;
        Ok(StoreGuard {
            _local: local,
            file,
        })
    }

    fn load(&self) -> AppResult<LoadedCatalog> {
        load_unlocked(&self.data_dir).map_err(|error| {
            AppError::Message(format!(
                "could not load provider settings from '{}': {error}. Close CeraChat, replace the incompatible settings.json and secrets*.json files, or move both out and configure from scratch; files were left unchanged",
                self.data_dir.display()
            ))
        })
    }
}

fn load_unlocked(data_dir: &Path) -> AppResult<LoadedCatalog> {
    let settings_path = data_dir.join(SETTINGS_FILE);
    if !settings_path.exists() {
        if has_secret_files(data_dir)? {
            return Err(AppError::Message(
                "settings.json is missing while persisted secret data exists".into(),
            ));
        }
        return Ok(LoadedCatalog {
            catalog: ProviderCatalog::default(),
            api_keys: HashMap::new(),
        });
    }
    if data_dir.join(LEGACY_SECRETS_FILE).exists() {
        return Err(AppError::Message(
            "legacy secrets.json is incompatible with settings version 1".into(),
        ));
    }

    let settings: SettingsFile = read_json(&settings_path, "settings")?;
    if settings.version != SETTINGS_VERSION {
        return Err(AppError::Message(format!(
            "unsupported settings version {}; expected {}",
            settings.version, SETTINGS_VERSION
        )));
    }
    validate_generation(&settings.secret_generation)?;
    let secrets_path = secret_path(data_dir, &settings.secret_generation);
    if !secrets_path.is_file() {
        return Err(AppError::Message(format!(
            "secret generation '{}' referenced by settings.json is missing",
            settings.secret_generation
        )));
    }
    let secrets: SecretFile = read_json(&secrets_path, "secrets")?;
    if secrets.version != SECRETS_VERSION {
        return Err(AppError::Message(format!(
            "unsupported secrets version {}; expected {}",
            secrets.version, SECRETS_VERSION
        )));
    }
    if secrets.generation != settings.secret_generation {
        return Err(AppError::Message(
            "secret generation does not match the settings reference".into(),
        ));
    }

    let catalog = ProviderCatalog {
        providers: settings.providers,
        models: settings.models,
        selected_model_id: settings.selected_model_id,
    };
    validate_catalog(&catalog, &secrets.api_keys)?;
    Ok(LoadedCatalog {
        catalog,
        api_keys: secrets.api_keys,
    })
}

fn resolve_active(loaded: LoadedCatalog) -> AppResult<ProviderConfig> {
    let selected = loaded.catalog.selected_model_id.as_deref().ok_or_else(|| {
        AppError::Message("no model is selected; choose a provider model before sending".into())
    })?;
    let (provider_id, model_id) = split_unique_model_id(selected)
        .ok_or_else(|| AppError::Message("stored model selection is malformed".into()))?;
    let provider = loaded
        .catalog
        .providers
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| {
            AppError::Message(format!("selected provider '{provider_id}' is missing"))
        })?;
    let model = loaded
        .catalog
        .models
        .iter()
        .find(|m| m.provider_id == provider_id && m.model_id == model_id)
        .ok_or_else(|| AppError::Message(format!("selected model '{selected}' is missing")))?;
    let api_key = loaded.api_keys.get(provider_id).ok_or_else(|| {
        AppError::Message(format!(
            "API key entry for provider '{provider_id}' is missing"
        ))
    })?;

    Ok(ProviderConfig {
        id: provider.id.clone(),
        name: provider.name.clone(),
        protocol: provider.protocol.clone(),
        base_url: provider.base_url.clone(),
        api_key: api_key.clone(),
        api_key_storage: provider.api_key_storage.clone(),
        model: model.model_id.clone(),
        context_window: model.context_window,
        max_output_tokens: model.max_output_tokens,
        system_text: provider.system_text.clone(),
        temperature: provider.temperature,
        raw_json_overrides: provider.raw_json_overrides.clone(),
        context_separator: provider.context_separator.clone(),
    })
}

fn validate_catalog(
    catalog: &ProviderCatalog,
    api_keys: &HashMap<String, String>,
) -> AppResult<()> {
    let mut provider_ids = HashSet::new();
    for provider in &catalog.providers {
        validate_provider(provider)?;
        if !provider_ids.insert(provider.id.as_str()) {
            return Err(AppError::Message(format!(
                "duplicate provider id '{}'",
                provider.id
            )));
        }
    }
    let mut model_ids = HashSet::new();
    for model in &catalog.models {
        validate_model(model)?;
        if !provider_ids.contains(model.provider_id.as_str()) {
            return Err(AppError::Message(format!(
                "model '{}::{}' references an unknown provider",
                model.provider_id, model.model_id
            )));
        }
        if !model_ids.insert((model.provider_id.as_str(), model.model_id.as_str())) {
            return Err(AppError::Message(format!(
                "duplicate model '{}::{}'",
                model.provider_id, model.model_id
            )));
        }
    }

    let key_ids: HashSet<&str> = api_keys.keys().map(String::as_str).collect();
    if key_ids != provider_ids {
        let missing = provider_ids
            .difference(&key_ids)
            .copied()
            .collect::<Vec<_>>();
        let unknown = key_ids
            .difference(&provider_ids)
            .copied()
            .collect::<Vec<_>>();
        return Err(AppError::Message(format!(
            "provider-keyed secrets do not match the catalog (missing: {}; unknown: {})",
            display_ids(&missing),
            display_ids(&unknown)
        )));
    }
    if let Some(selected) = &catalog.selected_model_id {
        let (provider_id, model_id) = split_unique_model_id(selected).ok_or_else(|| {
            AppError::Message("selected_model_id must use provider_id::model_id".into())
        })?;
        if !provider_ids.contains(provider_id) {
            return Err(AppError::Message(format!(
                "selected provider '{provider_id}' does not exist"
            )));
        }
        if !model_ids.contains(&(provider_id, model_id)) {
            return Err(AppError::Message(format!(
                "selected model '{selected}' does not exist"
            )));
        }
    }
    Ok(())
}

fn validate_provider(provider: &ProviderProfile) -> AppResult<()> {
    validate_id("provider id", &provider.id)?;
    if provider.id.ends_with(':') {
        return Err(AppError::Message(
            "provider id must not end with ':' because it would overlap the '::' model separator"
                .into(),
        ));
    }
    if provider.name.trim().is_empty() {
        return Err(AppError::Message("provider name must not be empty".into()));
    }
    if provider.base_url.trim().is_empty() {
        return Err(AppError::Message(
            "provider base_url must not be empty".into(),
        ));
    }
    if !matches!(
        provider.protocol.as_str(),
        "openai_chat_completions" | "openai_responses"
    ) {
        return Err(AppError::Message(format!(
            "unsupported provider protocol: {}",
            provider.protocol
        )));
    }
    if provider.api_key_storage != "plain_portable" {
        return Err(AppError::Message(format!(
            "unsupported API key storage mode: {}",
            provider.api_key_storage
        )));
    }
    if provider.temperature.is_some_and(|value| !value.is_finite()) {
        return Err(AppError::Message(
            "provider temperature must be finite".into(),
        ));
    }
    let overrides: Value = serde_json::from_str(&provider.raw_json_overrides).map_err(|error| {
        AppError::Message(format!("provider raw_json_overrides is invalid: {error}"))
    })?;
    if !overrides.is_object() {
        return Err(AppError::Message(
            "provider raw_json_overrides must be a JSON object".into(),
        ));
    }
    Ok(())
}

fn validate_model(model: &ModelProfile) -> AppResult<()> {
    validate_id("model provider_id", &model.provider_id)?;
    validate_id("model id", &model.model_id)?;
    if model.context_window == 0 || model.max_output_tokens == 0 {
        return Err(AppError::Message(
            "model token limits must be greater than zero".into(),
        ));
    }
    Ok(())
}

fn validate_id(label: &str, id: &str) -> AppResult<()> {
    if id.trim().is_empty() || id != id.trim() || id.contains("::") {
        return Err(AppError::Message(format!(
            "{label} must be non-empty, trimmed, and must not contain '::'"
        )));
    }
    Ok(())
}

fn split_unique_model_id(value: &str) -> Option<(&str, &str)> {
    let (provider_id, model_id) = value.split_once("::")?;
    if provider_id.is_empty() || model_id.is_empty() || model_id.contains("::") {
        return None;
    }
    Some((provider_id, model_id))
}

fn unique_model_id(provider_id: &str, model_id: &str) -> String {
    format!("{provider_id}::{model_id}")
}

fn persist(
    data_dir: &Path,
    catalog: &ProviderCatalog,
    api_keys: &HashMap<String, String>,
) -> AppResult<()> {
    persist_with_hook(data_dir, catalog, api_keys, || Ok(()))
}

fn persist_with_hook<F>(
    data_dir: &Path,
    catalog: &ProviderCatalog,
    api_keys: &HashMap<String, String>,
    before_commit: F,
) -> AppResult<()>
where
    F: FnOnce() -> AppResult<()>,
{
    validate_catalog(catalog, api_keys)?;
    fs::create_dir_all(data_dir)?;
    let generation = Uuid::new_v4().to_string();
    let secrets = SecretFile {
        version: SECRETS_VERSION,
        generation: generation.clone(),
        api_keys: api_keys.clone(),
    };
    let settings = SettingsFile {
        version: SETTINGS_VERSION,
        secret_generation: generation.clone(),
        selected_model_id: catalog.selected_model_id.clone(),
        providers: catalog.providers.clone(),
        models: catalog.models.clone(),
    };
    let secret_bytes = serde_json::to_vec_pretty(&secrets)?;
    let settings_bytes = serde_json::to_vec_pretty(&settings)?;
    // Immutable secrets are durable before settings.json points at them.
    let new_secret_path = secret_path(data_dir, &generation);
    write_new_synced(&new_secret_path, &secret_bytes)?;
    let commit_result = (|| -> AppResult<()> {
        sync_directory(data_dir)?;
        before_commit()?;
        replace_synced(&data_dir.join(SETTINGS_FILE), &settings_bytes)
    })();
    if let Err(error) = commit_result {
        let _ = fs::remove_file(new_secret_path);
        return Err(error);
    }
    // settings.json is now committed. Cleanup is best-effort so a cleanup failure cannot
    // turn a successful commit into a reported failure.
    let _ = sync_directory(data_dir);
    cleanup_secret_generations(data_dir, &generation);
    Ok(())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path, label: &str) -> AppResult<T> {
    serde_json::from_slice(&fs::read(path)?).map_err(|error| {
        AppError::Message(format!(
            "invalid {label} file '{}': {error}",
            path.display()
        ))
    })
}

pub(crate) fn deserialize_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn deserialize_unique_map<'de, D>(deserializer: D) -> Result<HashMap<String, String>, D::Error>
where
    D: Deserializer<'de>,
{
    struct UniqueMapVisitor;
    impl<'de> serde::de::Visitor<'de> for UniqueMapVisitor {
        type Value = HashMap<String, String>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("an object with unique provider IDs")
        }

        fn visit_map<A>(self, mut access: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            let mut values = HashMap::new();
            while let Some((key, value)) = access.next_entry::<String, String>()? {
                if values.insert(key.clone(), value).is_some() {
                    return Err(serde::de::Error::custom(format!(
                        "duplicate API key entry '{key}'"
                    )));
                }
            }
            Ok(values)
        }
    }
    deserializer.deserialize_map(UniqueMapVisitor)
}

fn validate_generation(generation: &str) -> AppResult<()> {
    let parsed = Uuid::parse_str(generation)
        .map_err(|_| AppError::Message("settings secret_generation is invalid".into()))?;
    if parsed.to_string() != generation {
        return Err(AppError::Message(
            "settings secret_generation is not canonical".into(),
        ));
    }
    Ok(())
}

fn secret_path(data_dir: &Path, generation: &str) -> PathBuf {
    data_dir.join(format!("secrets.{generation}.json"))
}

fn has_secret_files(data_dir: &Path) -> AppResult<bool> {
    if !data_dir.exists() {
        return Ok(false);
    }
    for entry in fs::read_dir(data_dir)? {
        let name = entry?.file_name();
        let name = name.to_string_lossy();
        if name == LEGACY_SECRETS_FILE || (name.starts_with("secrets.") && name.ends_with(".json"))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn cleanup_secret_generations(data_dir: &Path, active_generation: &str) {
    let active_name = format!("secrets.{active_generation}.json");
    let Ok(entries) = fs::read_dir(data_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(generation) = name
            .strip_prefix("secrets.")
            .and_then(|name| name.strip_suffix(".json"))
        else {
            continue;
        };
        if name != active_name && validate_generation(generation).is_ok() {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn write_new_synced(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    let result = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = result {
        let _ = fs::remove_file(path);
        return Err(error.into());
    }
    Ok(())
}

fn replace_synced(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let temp = path.with_file_name(format!(".settings.{}.tmp", Uuid::new_v4()));
    let result = (|| -> AppResult<()> {
        write_new_synced(&temp, bytes)?;
        replace_file(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> AppResult<()> {
    fs::rename(source, destination)?;
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> AppResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let success = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if success == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> AppResult<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> AppResult<()> {
    Ok(())
}

fn display_ids(ids: &[&str]) -> String {
    if ids.is_empty() {
        "none".into()
    } else {
        ids.join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("cerachat-settings-test-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn provider(id: &str) -> ProviderProfile {
        ProviderProfile {
            id: id.into(),
            name: format!("Provider {id}"),
            protocol: "openai_responses".into(),
            base_url: format!("https://{id}.example/v1"),
            api_key_storage: "plain_portable".into(),
            system_text: "system".into(),
            temperature: Some(0.25),
            raw_json_overrides: "{}".into(),
            context_separator: "\n---\n".into(),
        }
    }
    fn model(provider_id: &str, model_id: &str) -> ModelProfile {
        ModelProfile {
            provider_id: provider_id.into(),
            model_id: model_id.into(),
            name: format!("Model {model_id}"),
            context_window: 8_192,
            max_output_tokens: 1_024,
        }
    }
    fn configured_store() -> (TempDir, SettingsStore) {
        let dir = TempDir::new();
        let store = SettingsStore::new(dir.0.clone());
        store
            .save_provider(provider("alpha"), Some("secret-a".into()))
            .unwrap();
        store.save_model(model("alpha", "one")).unwrap();
        store.select_model("alpha::one").unwrap();
        (dir, store)
    }

    #[test]
    fn fresh_install_requires_both_settings_and_secrets_to_be_absent() {
        let dir = TempDir::new();
        assert_eq!(
            SettingsStore::new(dir.0.clone()).load_catalog().unwrap(),
            ProviderCatalog::default()
        );
        fs::write(dir.0.join(LEGACY_SECRETS_FILE), b"{}").unwrap();
        assert!(SettingsStore::new(dir.0.clone()).load_catalog().is_err());
    }

    #[test]
    fn crud_supports_multiple_records_and_clears_active_deletions() {
        let (_dir, store) = configured_store();
        store.save_provider(provider("beta"), None).unwrap();
        store.save_model(model("alpha", "two")).unwrap();
        store.save_model(model("beta", "one")).unwrap();
        let catalog = store.delete_model("alpha", "two").unwrap();
        assert_eq!(catalog.providers.len(), 2);
        assert_eq!(catalog.models.len(), 2);
        assert_eq!(catalog.selected_model_id.as_deref(), Some("alpha::one"));
        assert!(store.delete_model("missing", "model").is_err());
        assert_eq!(
            store
                .delete_model("alpha", "one")
                .unwrap()
                .selected_model_id,
            None
        );
        store.select_model("beta::one").unwrap();
        let catalog = store.delete_provider("beta").unwrap();
        assert_eq!(catalog.selected_model_id, None);
        assert!(catalog.models.iter().all(|item| item.provider_id != "beta"));
    }

    #[test]
    fn null_key_preserves_existing_and_creates_explicit_empty_key() {
        let (_dir, store) = configured_store();
        let mut edited = provider("alpha");
        edited.name = "Edited".into();
        store.save_provider(edited, None).unwrap();
        assert_eq!(store.load_active_provider().unwrap().api_key, "secret-a");
        store.save_provider(provider("empty"), None).unwrap();
        store.save_model(model("empty", "m")).unwrap();
        store.select_model("empty::m").unwrap();
        assert_eq!(store.load_active_provider().unwrap().api_key, "");
    }

    #[test]
    fn successful_save_cleans_generations_but_preserves_unrelated_secret_backup() {
        let dir = TempDir::new();
        let backup = dir.0.join("secrets.backup.json");
        fs::write(&backup, b"user backup").unwrap();
        let store = SettingsStore::new(dir.0.clone());
        // A settings-less directory containing secret material is intentionally incompatible.
        fs::remove_file(&backup).unwrap();
        store
            .save_provider(provider("alpha"), Some("old".into()))
            .unwrap();
        fs::write(&backup, b"user backup").unwrap();
        store
            .save_provider(provider("alpha"), Some("new".into()))
            .unwrap();
        assert_eq!(fs::read(&backup).unwrap(), b"user backup");
        let generations = fs::read_dir(&dir.0)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with("secrets.")
                    && name.ends_with(".json")
                    && name != "secrets.backup.json"
            })
            .count();
        assert_eq!(generations, 1);
    }

    #[test]
    fn settings_never_contains_api_keys() {
        let (dir, _store) = configured_store();
        let text = fs::read_to_string(dir.0.join(SETTINGS_FILE)).unwrap();
        assert!(!text.contains("secret-a"));
        assert!(!text.contains("\"api_key\""));
    }

    #[test]
    fn resolver_uses_selected_provider_model_limits_protocol_and_key() {
        let (_dir, store) = configured_store();
        let resolved = store.load_active_provider().unwrap();
        assert_eq!(resolved.id, "alpha");
        assert_eq!(resolved.base_url, "https://alpha.example/v1");
        assert_eq!(resolved.protocol, "openai_responses");
        assert_eq!(resolved.api_key, "secret-a");
        assert_eq!(resolved.model, "one");
        assert_eq!(resolved.context_window, 8_192);
        assert_eq!(resolved.max_output_tokens, 1_024);
    }

    #[test]
    fn resolver_has_no_fallback_when_selection_is_missing() {
        let dir = TempDir::new();
        let store = SettingsStore::new(dir.0.clone());
        store.save_provider(provider("alpha"), None).unwrap();
        store.save_model(model("alpha", "one")).unwrap();
        assert!(store
            .load_active_provider()
            .unwrap_err()
            .to_string()
            .contains("no model is selected"));
        assert!(store.select_model("alpha::missing").is_err());
        assert!(store.select_model("missing::one").is_err());
    }

    #[test]
    fn failed_commit_preserves_previous_valid_generation() {
        let (dir, store) = configured_store();
        let before = store.load_catalog().unwrap();
        let loaded = load_unlocked(&dir.0).unwrap();
        let mut changed = loaded.catalog;
        changed.providers[0].name = "Should not commit".into();
        let error = persist_with_hook(&dir.0, &changed, &loaded.api_keys, || {
            Err(AppError::Message("injected failure".into()))
        });
        assert!(error.is_err());
        assert_eq!(store.load_catalog().unwrap(), before);
        assert_eq!(store.load_active_provider().unwrap().name, "Provider alpha");
    }

    #[test]
    fn failed_first_commit_restores_fresh_install_state() {
        let dir = TempDir::new();
        let error = persist_with_hook(&dir.0, &ProviderCatalog::default(), &HashMap::new(), || {
            Err(AppError::Message("injected failure".into()))
        });
        assert!(error.is_err());
        assert_eq!(
            SettingsStore::new(dir.0.clone()).load_catalog().unwrap(),
            ProviderCatalog::default()
        );
        assert!(!has_secret_files(&dir.0).unwrap());
    }

    #[test]
    fn strict_loader_rejects_versions_unknown_fields_duplicates_orphans_and_secrets() {
        let (dir, _store) = configured_store();
        let settings_path = dir.0.join(SETTINGS_FILE);
        let original: Value = serde_json::from_slice(&fs::read(&settings_path).unwrap()).unwrap();
        for mutation in [
            |value: &mut Value| {
                value.as_object_mut().unwrap().remove("version");
            },
            |value: &mut Value| {
                value.as_object_mut().unwrap().remove("selected_model_id");
            },
            |value: &mut Value| {
                value["providers"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("temperature");
            },
            |value: &mut Value| {
                value["version"] = Value::from(999);
            },
            |value: &mut Value| {
                value["version"] = Value::String("1".into());
            },
            |value: &mut Value| {
                value["unknown"] = Value::Bool(true);
            },
            |value: &mut Value| {
                value["providers"][0]["unknown"] = Value::Bool(true);
            },
        ] {
            let mut changed = original.clone();
            mutation(&mut changed);
            fs::write(&settings_path, serde_json::to_vec(&changed).unwrap()).unwrap();
            assert!(load_unlocked(&dir.0).is_err());
        }
        let mut duplicate = original.clone();
        let provider = duplicate["providers"][0].clone();
        duplicate["providers"]
            .as_array_mut()
            .unwrap()
            .push(provider);
        fs::write(&settings_path, serde_json::to_vec(&duplicate).unwrap()).unwrap();
        assert!(load_unlocked(&dir.0).is_err());
        let mut duplicate_model = original.clone();
        let model = duplicate_model["models"][0].clone();
        duplicate_model["models"]
            .as_array_mut()
            .unwrap()
            .push(model);
        fs::write(
            &settings_path,
            serde_json::to_vec(&duplicate_model).unwrap(),
        )
        .unwrap();
        assert!(load_unlocked(&dir.0).is_err());
        let mut orphan = original.clone();
        orphan["models"][0]["provider_id"] = Value::String("missing".into());
        fs::write(&settings_path, serde_json::to_vec(&orphan).unwrap()).unwrap();
        assert!(load_unlocked(&dir.0).is_err());

        fs::write(&settings_path, serde_json::to_vec(&original).unwrap()).unwrap();
        let generation = original["secret_generation"].as_str().unwrap();
        let secret_path = secret_path(&dir.0, generation);
        let mut secrets: Value = serde_json::from_slice(&fs::read(&secret_path).unwrap()).unwrap();
        secrets["api_keys"]["unknown"] = Value::String("bad".into());
        fs::write(&secret_path, serde_json::to_vec(&secrets).unwrap()).unwrap();
        assert!(load_unlocked(&dir.0).is_err());

        let duplicate_keys = format!(
            r#"{{"version":1,"generation":"{generation}","api_keys":{{"alpha":"one","alpha":"two"}}}}"#
        );
        assert!(serde_json::from_str::<SecretFile>(&duplicate_keys).is_err());
    }

    #[test]
    fn strict_loader_rejects_malformed_json_and_missing_generation() {
        let (dir, _store) = configured_store();
        let settings_path = dir.0.join(SETTINGS_FILE);
        fs::write(&settings_path, b"not json").unwrap();
        assert!(load_unlocked(&dir.0).is_err());
        fs::remove_file(&settings_path).unwrap();
        assert!(load_unlocked(&dir.0).is_err());
    }

    #[test]
    fn referenced_secret_generation_must_exist() {
        let (dir, store) = configured_store();
        let catalog_before = store.load_catalog().unwrap();
        let settings: SettingsFile = read_json(&dir.0.join(SETTINGS_FILE), "settings").unwrap();
        fs::remove_file(secret_path(&dir.0, &settings.secret_generation)).unwrap();
        let error = store.load_catalog().unwrap_err().to_string();
        assert!(error.contains("referenced by settings.json is missing"));
        let persisted: SettingsFile = read_json(&dir.0.join(SETTINGS_FILE), "settings").unwrap();
        assert_eq!(
            persisted.selected_model_id,
            catalog_before.selected_model_id
        );
    }

    #[test]
    fn separate_store_instances_do_not_lose_concurrent_updates() {
        let dir = TempDir::new();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = [dir.0.clone(), dir.0.clone()]
            .into_iter()
            .enumerate()
            .map(|(index, path)| {
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    SettingsStore::new(path)
                        .save_provider(provider(&format!("provider-{index}")), None)
                        .unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        let catalog = SettingsStore::new(dir.0.clone()).load_catalog().unwrap();
        assert_eq!(catalog.providers.len(), 2);
    }

    #[test]
    fn qualified_ids_do_not_allow_overlapping_provider_separators() {
        let dir = TempDir::new();
        let store = SettingsStore::new(dir.0.clone());
        assert!(store.save_provider(provider("alpha:"), None).is_err());
        assert!(store.load_catalog().unwrap().providers.is_empty());
        store.save_provider(provider("alpha"), None).unwrap();
        for model_id in ["qwen3:8b", ":custom", "trailing:"] {
            store.save_model(model("alpha", model_id)).unwrap();
            store
                .select_model(&unique_model_id("alpha", model_id))
                .unwrap();
            assert_eq!(store.load_active_provider().unwrap().model, model_id);
        }
    }

    #[test]
    fn invalid_catalog_and_secret_records_fail_without_rewriting_files() {
        let (dir, store) = configured_store();
        let settings_path = dir.0.join(SETTINGS_FILE);
        let original = fs::read(&settings_path).unwrap();
        let settings: SettingsFile = serde_json::from_slice(&original).unwrap();
        let secrets_path = secret_path(&dir.0, &settings.secret_generation);
        let original_secrets = fs::read(&secrets_path).unwrap();
        for selected in ["missing::one", "alpha::missing", "alpha::one::extra"] {
            let mut value: Value = serde_json::from_slice(&original).unwrap();
            value["selected_model_id"] = Value::String(selected.into());
            let invalid = serde_json::to_vec(&value).unwrap();
            fs::write(&settings_path, &invalid).unwrap();
            let error = store.load_active_provider().unwrap_err().to_string();
            assert!(error.contains("configure from scratch"));
            assert_eq!(fs::read(&settings_path).unwrap(), invalid);
            assert_eq!(fs::read(&secrets_path).unwrap(), original_secrets);
        }
        fs::write(&settings_path, &original).unwrap();
        for mutate in [
            |value: &mut Value| {
                value.as_object_mut().unwrap().remove("version");
            },
            |value: &mut Value| {
                value["version"] = Value::from(2);
            },
            |value: &mut Value| {
                value["version"] = Value::String("1".into());
            },
            |value: &mut Value| {
                value["generation"] = Value::String(Uuid::new_v4().to_string());
            },
            |value: &mut Value| {
                value["api_keys"].as_object_mut().unwrap().remove("alpha");
            },
            |value: &mut Value| {
                value["api_keys"]["alpha"] = Value::Null;
            },
        ] {
            let mut value: Value = serde_json::from_slice(&original_secrets).unwrap();
            mutate(&mut value);
            let invalid = serde_json::to_vec(&value).unwrap();
            fs::write(&secrets_path, &invalid).unwrap();
            assert!(store.load_catalog().is_err());
            assert!(store.select_model("alpha::one").is_err());
            assert_eq!(fs::read(&settings_path).unwrap(), original);
            assert_eq!(fs::read(&secrets_path).unwrap(), invalid);
        }
        fs::write(&secrets_path, &original_secrets).unwrap();
        let mut invalid_provider = provider("alpha");
        invalid_provider.protocol = "unsupported".into();
        assert!(store
            .save_provider(invalid_provider, Some("changed".into()))
            .is_err());
        assert!(store.save_model(model("missing", "one")).is_err());
        assert!(store.select_model("alpha::missing").is_err());
        assert_eq!(fs::read(settings_path).unwrap(), original);
        assert_eq!(fs::read(secrets_path).unwrap(), original_secrets);
    }

    #[test]
    fn local_catalog_operations_make_no_connections_and_selected_config_drives_one_post() {
        use crate::{
            context::compiler,
            db::{chat, Database},
            models::CompileRequestArgs,
            providers::openai_compatible,
        };
        use std::{
            io::Read,
            net::TcpListener,
            time::{Duration, Instant},
        };

        let runtime = tokio::runtime::Runtime::new().unwrap();
        for (protocol, endpoint, limit_field, delta) in [
            (
                "openai_chat_completions",
                "/v1/chat/completions",
                "max_tokens",
                r#"{"choices":[{"delta":{"content":"hello"}}]}"#,
            ),
            (
                "openai_responses",
                "/v1/responses",
                "max_output_tokens",
                r#"{"type":"response.output_text.delta","delta":"hello"}"#,
            ),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let inactive_listener = TcpListener::bind("127.0.0.1:0").unwrap();
            inactive_listener.set_nonblocking(true).unwrap();
            let dir = TempDir::new();
            let store = SettingsStore::new(dir.0.clone());
            let db = Database::open(dir.0.join("chat.sqlite3")).unwrap();
            let conversation = chat::create_conversation(&db).unwrap();
            assert!(store.load_catalog().unwrap().providers.is_empty());
            let mut inactive = provider("inactive");
            inactive.base_url = format!("http://{}/v1", inactive_listener.local_addr().unwrap());
            store
                .save_provider(inactive, Some("wrong-key".into()))
                .unwrap();
            store.save_model(model("inactive", "wrong-model")).unwrap();
            store.select_model("inactive::wrong-model").unwrap();
            let mut selected = provider("selected");
            selected.protocol = protocol.into();
            selected.base_url = format!("http://{}/v1", listener.local_addr().unwrap());
            store
                .save_provider(selected, Some("selected-key".into()))
                .unwrap();
            store.save_model(model("selected", "temporary")).unwrap();
            store.delete_model("selected", "temporary").unwrap();
            let mut selected_model = model("selected", "actual-api-model");
            selected_model.context_window = 64_000;
            selected_model.max_output_tokens = 2_048;
            store.save_model(selected_model).unwrap();
            store.select_model("selected::actual-api-model").unwrap();
            // A new store simulates a restart, then the real request compiler resolves the selection.
            let restarted = SettingsStore::new(dir.0.clone());
            let resolved = restarted.load_active_provider().unwrap();
            let compiled = compiler::compile(
                &db,
                &resolved,
                &CompileRequestArgs {
                    conversation_id: conversation.id,
                    parent_id: None,
                    input: "test input".into(),
                    history_mode: "no_history".into(),
                    since_message_id: None,
                },
            )
            .unwrap();
            assert_eq!(compiled.breakdown.configured_context, 64_000);
            assert_eq!(compiled.breakdown.max_output_tokens, 2_048);
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
            assert_eq!(
                inactive_listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );

            let server = std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(10);
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                Instant::now() < deadline,
                                "explicit request never reached the selected endpoint"
                            );
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("mock endpoint failed: {error}"),
                    }
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .unwrap();
                let mut bytes = Vec::new();
                let (headers, body_start, content_length) = loop {
                    let mut chunk = [0; 1024];
                    let read = socket.read(&mut chunk).unwrap();
                    assert!(read > 0, "request ended before its headers");
                    bytes.extend_from_slice(&chunk[..read]);
                    if let Some(offset) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8(bytes[..offset].to_vec()).unwrap();
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap();
                        break (headers, offset + 4, length);
                    }
                };
                while bytes.len() < body_start + content_length {
                    let mut chunk = [0; 1024];
                    let read = socket.read(&mut chunk).unwrap();
                    assert!(read > 0, "request ended before its body");
                    bytes.extend_from_slice(&chunk[..read]);
                }
                let body: Value =
                    serde_json::from_slice(&bytes[body_start..body_start + content_length])
                        .unwrap();
                let response = format!("data: {delta}\n\ndata: [DONE]\n\n");
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
                (listener, headers, body)
            });
            let output = runtime
                .block_on(openai_compatible::stream_once(
                    &resolved,
                    compiled.request_json.clone(),
                    |_| Ok(()),
                ))
                .unwrap();
            assert_eq!(output, "hello");
            let (listener, headers, body) = server.join().unwrap();
            assert!(headers.starts_with(&format!("POST {endpoint} HTTP/1.1\r\n")));
            assert!(headers
                .to_ascii_lowercase()
                .contains("authorization: bearer selected-key\r\n"));
            assert_eq!(
                body,
                serde_json::from_str::<Value>(&compiled.request_json).unwrap()
            );
            assert_eq!(body["model"], "actual-api-model");
            assert_eq!(body[limit_field], 2_048);
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
            assert_eq!(
                inactive_listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
        }
    }
}
