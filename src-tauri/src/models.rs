use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub parent_id: Option<String>,
    pub role: String,
    pub content: String,
    pub include_next: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub base_url: String,
    pub api_key: String,
    pub api_key_storage: String,
    pub model: String,
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub system_text: String,
    pub temperature: Option<f32>,
    pub raw_json_overrides: String,
    pub context_separator: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderProfile {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub base_url: String,
    pub api_key_storage: String,
    pub system_text: String,
    #[serde(deserialize_with = "crate::portable::settings::deserialize_nullable")]
    pub temperature: Option<f32>,
    pub raw_json_overrides: String,
    pub context_separator: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelProfile {
    pub provider_id: String,
    pub model_id: String,
    pub name: String,
    pub context_window: u32,
    pub max_output_tokens: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderCatalog {
    pub providers: Vec<ProviderProfile>,
    pub models: Vec<ModelProfile>,
    pub selected_model_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSource {
    pub id: String,
    pub display_name: String,
    pub origin_path: String,
    pub archive_path: Option<String>,
    pub blob_hash: String,
    pub original_size: i64,
    pub line_count: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextSlice {
    pub id: String,
    pub source_id: String,
    pub source_name: String,
    pub range_type: String,
    pub start_pos: Option<i64>,
    pub end_pos: Option<i64>,
    pub enabled: bool,
    pub sort_order: i64,
    pub wrapper: String,
    pub insert_at: String,
    pub estimated_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceLines {
    pub source_id: String,
    pub start_line: usize,
    pub total_lines: usize,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestBreakdown {
    pub system_tokens: u64,
    pub history_tokens: u64,
    pub workspace_tokens: u64,
    pub input_tokens: u64,
    pub estimated_input_tokens: u64,
    pub configured_context: u32,
    pub max_output_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestPreview {
    pub request_json: String,
    pub compiled_prompt: String,
    pub request_sha256: String,
    pub breakdown: RequestBreakdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapState {
    pub conversations: Vec<Conversation>,
    pub provider_catalog: ProviderCatalog,
    pub sources: Vec<WorkspaceSource>,
    pub slices: Vec<ContextSlice>,
    pub data_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamPayload {
    pub request_id: String,
    pub conversation_id: String,
    pub kind: String,
    pub text: Option<String>,
    pub error: Option<String>,
    pub assistant_message: Option<Message>,
    pub user_message: Option<Message>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileRequestArgs {
    pub conversation_id: String,
    pub parent_id: Option<String>,
    pub input: String,
    pub history_mode: String,
    pub since_message_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegenerateArgs {
    pub conversation_id: String,
    pub user_message_id: String,
    pub history_mode: String,
    pub since_message_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddSliceArgs {
    pub source_id: String,
    pub range_type: String,
    pub start_pos: Option<i64>,
    pub end_pos: Option<i64>,
    pub wrapper: String,
    pub insert_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSliceArgs {
    pub slice_id: String,
    pub enabled: Option<bool>,
    pub wrapper: Option<String>,
    pub insert_at: Option<String>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct CanonicalMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct CanonicalRequest {
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<CanonicalMessage>,
    pub temperature: Option<f32>,
    pub max_output_tokens: u32,
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct CompiledRequest {
    pub request_json: String,
    pub compiled_prompt: String,
    pub request_sha256: String,
    pub breakdown: RequestBreakdown,
    pub context_blob_hashes: Vec<String>,
}
