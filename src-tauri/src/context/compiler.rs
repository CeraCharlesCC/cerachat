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
    "input",
    "instructions",
    "stream",
    "max_tokens",
    "max_completion_tokens",
    "max_output_tokens",
    "temperature",
    "previous_response_id",
    "conversation",
    "prompt",
    "background",
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
    let workspace = compile_workspace(db, &args.conversation_id, &provider.context_separator)?;

    let mut system = provider.system_text.clone();
    append_part(&mut system, &workspace.system, &provider.context_separator);

    let mut messages = Vec::new();
    if !workspace.before_history.is_empty() {
        messages.push(CanonicalMessage {
            role: "user".into(),
            content: workspace.before_history.clone(),
        });
    }
    messages.extend(history.iter().map(|message| CanonicalMessage {
        role: message.role.clone(),
        content: history_content(message),
    }));

    let mut current = String::new();
    if !workspace.before_current.is_empty() {
        current.push_str(&workspace.before_current);
        if !args.input.is_empty() {
            current.push_str(&provider.context_separator);
        }
    }
    current.push_str(&args.input);
    if !workspace.inside_current.is_empty() {
        append_part(
            &mut current,
            &workspace.inside_current,
            &provider.context_separator,
        );
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
    let request_json = match provider.protocol.as_str() {
        "openai_chat_completions" => openai_request_json(&canonical)?,
        "openai_responses" => responses_request_json(&canonical)?,
        other => {
            return Err(AppError::Message(format!(
                "unsupported provider protocol: {other}"
            )))
        }
    };
    let request_sha256 = hex::encode(Sha256::digest(request_json.as_bytes()));
    let compiled_prompt = audit_prompt(&canonical);

    let system_tokens = estimate_tokens(&provider.system_text);
    let history_tokens = history
        .iter()
        .map(|message| estimate_tokens(&history_content(message)))
        .sum();
    let input_tokens = estimate_tokens(&args.input);
    let mut separator_tokens = 0;
    if !workspace.before_current.is_empty() && !args.input.is_empty() {
        separator_tokens += estimate_tokens(&provider.context_separator);
    }
    if !workspace.inside_current.is_empty()
        && (!workspace.before_current.is_empty() || !args.input.is_empty())
    {
        separator_tokens += estimate_tokens(&provider.context_separator);
    }
    if !provider.system_text.is_empty() && !workspace.system.is_empty() {
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

// Visible reasoning is sent as ordinary labeled assistant text. Native Responses
// reasoning replay requires original output items, which are not stored here.
fn history_content(message: &crate::models::Message) -> String {
    if message.role != "assistant" {
        return message.content.clone();
    }
    let mut parts = Vec::new();
    if let Some(reasoning) = &message.reasoning {
        for part in reasoning
            .parts
            .iter()
            .filter(|part| part.include_next && !part.text.is_empty())
        {
            let label = if part.kind == "summary" {
                "Selected reasoning summary"
            } else {
                "Selected reasoning text"
            };
            parts.push(format!("[{label}]\n{}\n[/{label}]", part.text));
        }
    }
    if !message.content.is_empty() {
        parts.push(message.content.clone());
    }
    parts.join("\n\n")
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

fn compile_workspace(
    db: &Database,
    conversation_id: &str,
    separator: &str,
) -> AppResult<WorkspaceParts> {
    let mut parts = WorkspaceParts::default();
    let mut seen_hashes = HashSet::new();

    for slice in db_context::conversation_slices(db, conversation_id)?
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
        if seen_hashes.insert(source.blob_hash.clone()) {
            parts.blob_hashes.push(source.blob_hash);
        }
        match slice.insert_at.as_str() {
            "before_history" => append_part(&mut parts.before_history, &wrapped, separator),
            "before_current" => append_part(&mut parts.before_current, &wrapped, separator),
            "inside_current" => append_part(&mut parts.inside_current, &wrapped, separator),
            "system" => append_part(&mut parts.system, &wrapped, separator),
            other => {
                return Err(AppError::Message(format!(
                    "unsupported insertion point: {other}"
                )))
            }
        }
    }
    let joined_tokens: u64 = [
        &parts.before_history,
        &parts.before_current,
        &parts.inside_current,
        &parts.system,
    ]
    .iter()
    .map(|part| estimate_tokens(part))
    .sum();
    parts.token_estimate = joined_tokens;
    Ok(parts)
}

fn append_part(target: &mut String, part: &str, separator: &str) {
    if part.is_empty() {
        return;
    }
    if !target.is_empty() {
        target.push_str(separator);
    }
    target.push_str(part);
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
    body.insert(
        "max_completion_tokens".into(),
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

pub fn responses_request_json(request: &CanonicalRequest) -> AppResult<String> {
    let mut body = Map::new();
    body.insert("model".into(), Value::String(request.model.clone()));
    if let Some(system) = &request.system {
        body.insert("instructions".into(), Value::String(system.clone()));
    }
    let input = request
        .messages
        .iter()
        .map(|message| serde_json::json!({ "role": message.role, "content": message.content }))
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
    use super::*;

    #[test]
    fn attachment_order_and_separators_are_reflected_in_exact_requests() {
        let db = Database::open(":memory:".into()).unwrap();
        let conversation = chat::create_conversation(&db).unwrap();
        let provider = ProviderConfig {
            id: "test".into(),
            name: "Test".into(),
            protocol: "openai_chat_completions".into(),
            base_url: "http://unused.invalid".into(),
            api_key: String::new(),
            api_key_storage: "plain_portable".into(),
            model: "model".into(),
            context_window: 4096,
            max_output_tokens: 512,
            system_text: "system".into(),
            temperature: None,
            raw_json_overrides: "{}".into(),
            context_separator: "\n---\n".into(),
        };
        let other_chat = chat::create_conversation(&db).unwrap();
        let foreign_source = db_context::add_source(
            &db,
            &other_chat.id,
            "foreign.txt".into(),
            "paste".into(),
            None,
            "FOREIGN",
        )
        .unwrap();
        db_context::add_slice(
            &db,
            crate::models::AddSliceArgs {
                source_id: foreign_source.id,
                range_type: "all".into(),
                start_pos: None,
                end_pos: None,
                wrapper: "raw".into(),
                insert_at: "inside_current".into(),
            },
        )
        .unwrap();
        let mut ids = Vec::new();
        for (name, text) in [("a.txt", "AAA"), ("b.txt", "BBB")] {
            let source =
                db_context::add_source(&db, &conversation.id, name.into(), name.into(), None, text)
                    .unwrap();
            ids.push(
                db_context::add_slice(
                    &db,
                    crate::models::AddSliceArgs {
                        source_id: source.id,
                        range_type: "all".into(),
                        start_pos: None,
                        end_pos: None,
                        wrapper: "raw".into(),
                        insert_at: "inside_current".into(),
                    },
                )
                .unwrap()
                .id,
            );
        }
        let mut args = CompileRequestArgs {
            conversation_id: conversation.id.clone(),
            parent_id: None,
            input: "question".into(),
            history_mode: "full".into(),
            since_message_id: None,
        };
        let before = compile(&db, &provider, &args).unwrap();
        let json: Value = serde_json::from_str(&before.request_json).unwrap();
        assert_eq!(
            json["messages"][1]["content"],
            "question\n---\nAAA\n---\nBBB"
        );
        ids.reverse();
        db_context::reorder_slices(&db, &conversation.id, &ids).unwrap();
        let after = compile(&db, &provider, &args).unwrap();
        let json: Value = serde_json::from_str(&after.request_json).unwrap();
        assert_eq!(
            json["messages"][1]["content"],
            "question\n---\nBBB\n---\nAAA"
        );
        assert_ne!(before.request_sha256, after.request_sha256);
        let other = compile(
            &db,
            &provider,
            &CompileRequestArgs {
                conversation_id: other_chat.id,
                ..args.clone()
            },
        )
        .unwrap();
        let json: Value = serde_json::from_str(&other.request_json).unwrap();
        assert_eq!(json["messages"][1]["content"], "question\n---\nFOREIGN");
        args.input.clear();
        let standalone = compile(&db, &provider, &args).unwrap();
        let json: Value = serde_json::from_str(&standalone.request_json).unwrap();
        assert_eq!(json["messages"][1]["content"], "BBB\n---\nAAA");
    }

    #[test]
    fn reasoning_is_opt_in_per_block_for_both_protocols_and_respects_history_selection() {
        let db = Database::open(":memory:".into()).unwrap();
        let conversation = chat::create_conversation(&db).unwrap();
        let user = chat::insert_message(&db, &conversation.id, None, "user", "question").unwrap();
        let reasoning: crate::models::Reasoning = serde_json::from_value(serde_json::json!({
            "parts": [
                { "id": "s", "kind": "summary", "text": "visible summary" },
                { "id": "t", "kind": "text", "text": "visible steps" }
            ], "tokens": 42, "encrypted": true
        }))
        .unwrap();
        let reply = chat::insert_message_with_reasoning(
            &db,
            &conversation.id,
            Some(&user.id),
            "assistant",
            "answer",
            Some(reasoning),
        )
        .unwrap();
        let sibling = chat::insert_message(
            &db,
            &conversation.id,
            Some(&user.id),
            "assistant",
            "other answer",
        )
        .unwrap();
        let mut args = CompileRequestArgs {
            conversation_id: conversation.id,
            parent_id: Some(reply.id.clone()),
            input: "next".into(),
            history_mode: "full".into(),
            since_message_id: None,
        };
        let mut provider = ProviderConfig {
            id: "test".into(),
            name: "Test".into(),
            protocol: "openai_chat_completions".into(),
            base_url: "http://unused.invalid".into(),
            api_key: String::new(),
            api_key_storage: "plain_portable".into(),
            model: "model".into(),
            context_window: 4096,
            max_output_tokens: 512,
            system_text: String::new(),
            temperature: None,
            raw_json_overrides: "{}".into(),
            context_separator: "\n---\n".into(),
        };
        for protocol in ["openai_chat_completions", "openai_responses"] {
            provider.protocol = protocol.into();
            chat::set_reasoning_part_included(&db, &reply.id, "s", false).unwrap();
            let excluded = compile(&db, &provider, &args).unwrap();
            assert!(!excluded.request_json.contains("visible summary"));
            assert!(!excluded.compiled_prompt.contains("visible steps"));
            chat::set_reasoning_part_included(&db, &reply.id, "s", true).unwrap();
            let selected = compile(&db, &provider, &args).unwrap();
            let body: Value = serde_json::from_str(&selected.request_json).unwrap();
            let items = &body[if protocol == "openai_responses" {
                "input"
            } else {
                "messages"
            }];
            assert_eq!(items[1]["role"], "assistant");
            assert_eq!(items[1]["content"], "[Selected reasoning summary]\nvisible summary\n[/Selected reasoning summary]\n\nanswer");
            assert!(!selected.request_json.contains("visible steps"));
            assert!(!selected.request_json.contains("encrypted"));
            assert!(selected
                .compiled_prompt
                .contains("[assistant]\n[Selected reasoning summary]"));
            assert_ne!(excluded.request_sha256, selected.request_sha256);
            assert!(selected.breakdown.history_tokens > excluded.breakdown.history_tokens);
            assert_eq!(
                selected.request_sha256,
                compile(&db, &provider, &args).unwrap().request_sha256
            );

            chat::set_message_included(&db, &reply.id, false).unwrap();
            assert!(!compile(&db, &provider, &args)
                .unwrap()
                .request_json
                .contains("visible summary"));
            chat::set_message_included(&db, &reply.id, true).unwrap();
            args.history_mode = "no_history".into();
            assert!(!compile(&db, &provider, &args)
                .unwrap()
                .request_json
                .contains("visible summary"));
            args.history_mode = "full".into();
            args.parent_id = Some(sibling.id.clone());
            assert!(!compile(&db, &provider, &args)
                .unwrap()
                .request_json
                .contains("visible summary"));
            args.parent_id = Some(reply.id.clone());
            chat::set_reasoning_part_included(&db, &reply.id, "s", false).unwrap();
            assert_eq!(
                excluded.request_sha256,
                compile(&db, &provider, &args).unwrap().request_sha256
            );
        }
        chat::set_reasoning_part_included(&db, &reply.id, "s", true).unwrap();
        chat::set_reasoning_part_included(&db, &reply.id, "t", true).unwrap();
        let both = compile(&db, &provider, &args).unwrap();
        assert!(
            both.compiled_prompt.find("visible summary").unwrap()
                < both.compiled_prompt.find("visible steps").unwrap()
        );
        assert!(
            both.compiled_prompt.find("visible steps").unwrap()
                < both.compiled_prompt.find("\n\nanswer").unwrap()
        );
    }

    #[test]
    fn rejects_tool_overrides() {
        assert!(parse_overrides(r#"{"tools": []}"#).is_err());
        assert!(parse_overrides(r#"{"reasoning_effort": "high"}"#).is_ok());
    }
}
