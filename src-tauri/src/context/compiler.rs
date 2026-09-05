use std::collections::HashSet;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{
    db::{chat, context as db_context, Database},
    error::{AppError, AppResult},
    models::{
        CanonicalMessage, CanonicalRequest, CompileRequestArgs, CompiledRequest, ProviderConfig,
        RequestBreakdown,
    },
};

use super::text::{estimate_tokens, slice_text};

const RESERVED_OVERRIDE_KEYS: &[&str] = &[
    "model",
    "messages",
    "stream",
    "max_tokens",
    "max_completion_tokens",
    "temperature",
    "tools",
    "tool_choice",
    "functions",
    "function_call",
    "functionDeclarations",
    "parallel_tool_calls",
    "web_search_options",
    "mcp",
    "plugins",
];

#[derive(Default)]
struct WorkspaceParts {
    before_history: String,
    before_current: String,
    inside_current: String,
    system: String,
    token_estimate: u64,
    blob_hashes: Vec<String>,
}

pub fn compile(
    db: &Database,
    provider: &ProviderConfig,
    args: &CompileRequestArgs,
) -> AppResult<CompiledRequest> {
    let history = select_history(db, args)?;
    let workspace = compile_workspace(db)?;

    let mut system = provider.system_text.clone();
    system.push_str(&workspace.system);

    let mut messages = Vec::new();
    if !workspace.before_history.is_empty() {
        messages.push(CanonicalMessage {
            role: "user".into(),
            content: workspace.before_history.clone(),
        });
    }
    messages.extend(history.iter().map(|message| CanonicalMessage {
        role: message.role.clone(),
        content: message.content.clone(),
    }));

    let mut current = String::new();
    if !workspace.before_current.is_empty() {
        current.push_str(&workspace.before_current);
        current.push_str(&provider.context_separator);
    }
    current.push_str(&args.input);
    if !workspace.inside_current.is_empty() {
        current.push_str(&provider.context_separator);
        current.push_str(&workspace.inside_current);
    }
    if current.is_empty() {
        return Err(AppError::Message(
            "request has no current user content".into(),
        ));
    }
    messages.push(CanonicalMessage {
        role: "user".into(),
        content: current,
    });

    let extra = parse_overrides(&provider.raw_json_overrides)?;
    let canonical = CanonicalRequest {
        model: provider.model.clone(),
        system: (!system.is_empty()).then_some(system),
        messages,
        temperature: provider.temperature,
        max_output_tokens: provider.max_output_tokens,
        extra,
    };
    let request_json = if provider.protocol == "openai_responses" {
        responses_request_json(&canonical)?
    } else {
        openai_request_json(&canonical)?
    };
    let request_sha256 = hex::encode(Sha256::digest(request_json.as_bytes()));
    let compiled_prompt = audit_prompt(&canonical);

    let system_tokens = estimate_tokens(&provider.system_text);
    let history_tokens = history
        .iter()
        .map(|message| estimate_tokens(&message.content))
        .sum();
    let input_tokens = estimate_tokens(&args.input);
    let mut separator_tokens = 0;
    if !workspace.before_current.is_empty() {
        separator_tokens += estimate_tokens(&provider.context_separator);
    }
    if !workspace.inside_current.is_empty() {
        separator_tokens += estimate_tokens(&provider.context_separator);
    }
    let workspace_tokens = workspace.token_estimate + separator_tokens;
    let breakdown = RequestBreakdown {
        system_tokens,
        history_tokens,
        workspace_tokens,
        input_tokens,
        estimated_input_tokens: system_tokens + history_tokens + workspace_tokens + input_tokens,
        configured_context: provider.context_window,
        max_output_tokens: provider.max_output_tokens,
    };

    Ok(CompiledRequest {
        request_json,
        compiled_prompt,
        request_sha256,
        breakdown,
        context_blob_hashes: workspace.blob_hashes,
    })
}

fn select_history(
    db: &Database,
    args: &CompileRequestArgs,
) -> AppResult<Vec<crate::models::Message>> {
    let branch = chat::branch_to(db, args.parent_id.as_deref(), &args.conversation_id)?;
    let selected = match args.history_mode.as_str() {
        "full" => branch,
        "last10" => {
            let start = branch.len().saturating_sub(10);
            branch[start..].to_vec()
        }
        "since_here" => {
            let since_id = args
                .since_message_id
                .as_deref()
                .ok_or_else(|| AppError::Message("Since here requires a message".into()))?;
            let index = branch
                .iter()
                .position(|message| message.id == since_id)
                .ok_or_else(|| {
                    AppError::Message("Since here message is not on the active branch".into())
                })?;
            branch[index..].to_vec()
        }
        "selected" => branch,
        "no_history" => Vec::new(),
        other => {
            return Err(AppError::Message(format!(
                "unsupported history mode: {other}"
            )))
        }
    };

    Ok(selected
        .into_iter()
        .filter(|message| message.include_next)
        .collect())
}

fn compile_workspace(db: &Database) -> AppResult<WorkspaceParts> {
    let mut parts = WorkspaceParts::default();
    let mut seen_hashes = HashSet::new();

    for slice in db_context::list_slices(db)?
        .into_iter()
        .filter(|slice| slice.enabled)
    {
        let source = db_context::get_source(db, &slice.source_id)?
            .ok_or_else(|| AppError::Message("workspace source not found".into()))?;
        let source_text = db_context::source_text(db, &slice.source_id)?;
        let selected = slice_text(
            &source_text,
            &slice.range_type,
            slice.start_pos,
            slice.end_pos,
        )?;
        let wrapped = match slice.wrapper.as_str() {
            "raw" => selected,
            "labeled" => format!("{}\n{}", label_for_slice(&slice), selected),
            other => return Err(AppError::Message(format!("unsupported wrapper: {other}"))),
        };
        parts.token_estimate += estimate_tokens(&wrapped);
        if seen_hashes.insert(source.blob_hash.clone()) {
            parts.blob_hashes.push(source.blob_hash);
        }
        match slice.insert_at.as_str() {
            "before_history" => parts.before_history.push_str(&wrapped),
            "before_current" => parts.before_current.push_str(&wrapped),
            "inside_current" => parts.inside_current.push_str(&wrapped),
            "system" => parts.system.push_str(&wrapped),
            other => {
                return Err(AppError::Message(format!(
                    "unsupported insertion point: {other}"
                )))
            }
        }
    }
    Ok(parts)
}

fn label_for_slice(slice: &crate::models::ContextSlice) -> String {
    match slice.range_type.as_str() {
        "lines" => format!(
            "===== FILE: {} L{}-{} =====",
            slice.source_name,
            slice.start_pos.unwrap_or(1),
            slice.end_pos.unwrap_or(slice.start_pos.unwrap_or(1)),
        ),
        "chars" => format!(
            "===== FILE: {} chars {}-{} =====",
            slice.source_name,
            slice.start_pos.unwrap_or(0),
            slice.end_pos.unwrap_or(0),
        ),
        _ => format!("===== FILE: {} =====", slice.source_name),
    }
}

fn parse_overrides(raw: &str) -> AppResult<Map<String, Value>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Map::new());
    }
    let value: Value = serde_json::from_str(trimmed)?;
    let object = value
        .as_object()
        .ok_or_else(|| AppError::Message("raw JSON overrides must be a JSON object".into()))?;
    for key in object.keys() {
        if RESERVED_OVERRIDE_KEYS.contains(&key.as_str()) {
            return Err(AppError::Message(format!(
                "raw JSON override key '{key}' is reserved; request structure is controlled by CeraChat"
            )));
        }
    }
    Ok(object.clone())
}

fn openai_request_json(request: &CanonicalRequest) -> AppResult<String> {
    let mut body = Map::new();
    body.insert("model".into(), Value::String(request.model.clone()));
    let mut messages = Vec::new();
    if let Some(system) = &request.system {
        messages.push(serde_json::json!({ "role": "system", "content": system }));
    }
    messages.extend(
        request
            .messages
            .iter()
            .map(|message| serde_json::json!({ "role": message.role, "content": message.content })),
    );
    body.insert("messages".into(), Value::Array(messages));
    body.insert("stream".into(), Value::Bool(true));
    body.insert("max_tokens".into(), Value::from(request.max_output_tokens));
    if let Some(temperature) = request.temperature {
        body.insert("temperature".into(), Value::from(temperature));
    }
    for (key, value) in &request.extra {
        body.insert(key.clone(), value.clone());
    }
    Ok(serde_json::to_string_pretty(&Value::Object(body))?)
}

pub fn responses_request_json(request: &CanonicalRequest) -> AppResult<String> {
    let mut body = Map::new();
    body.insert("model".into(), Value::String(request.model.clone()));
    if let Some(system) = &request.system {
        body.insert("instructions".into(), Value::String(system.clone()));
    }
    let input = request
        .messages
        .iter()
        .map(|message| {
            serde_json::json!({
                "role": message.role,
                "content": [{ "type": "input_text", "text": message.content }]
            })
        })
        .collect::<Vec<_>>();
    body.insert("input".into(), Value::Array(input));
    body.insert("stream".into(), Value::Bool(true));
    body.insert(
        "max_output_tokens".into(),
        Value::from(request.max_output_tokens),
    );
    if let Some(temperature) = request.temperature {
        body.insert("temperature".into(), Value::from(temperature));
    }
    for (key, value) in &request.extra {
        body.insert(key.clone(), value.clone());
    }
    Ok(serde_json::to_string_pretty(&Value::Object(body))?)
}

fn audit_prompt(request: &CanonicalRequest) -> String {
    let mut output = String::new();
    if let Some(system) = &request.system {
        output.push_str("[system]\n");
        output.push_str(system);
        output.push('\n');
    }
    for message in &request.messages {
        output.push('[');
        output.push_str(&message.role);
        output.push_str("]\n");
        output.push_str(&message.content);
        output.push('\n');
    }
    output
}

#[cfg(test)]
mod tests {
    use super::parse_overrides;

    #[test]
    fn rejects_tool_overrides() {
        assert!(parse_overrides(r#"{"tools": []}"#).is_err());
        assert!(parse_overrides(r#"{"reasoning_effort": "high"}"#).is_ok());
    }
}
