use std::collections::HashSet;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{
    db::{chat, context as db_context, Database},
    error::{AppError, AppResult},
    models::{
        CanonicalMessage, CanonicalRequest, CompileRequestArgs, CompiledRequest, ProviderConfig,
        ReasoningReplayMode, RequestBreakdown,
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
    crate::images::validate(&args.images)?;
    let history = select_history(db, args)?;
    let image_count = args.images.len() + history.iter().map(|m| m.images.len()).sum::<usize>();
    if image_count > 0 && !provider.image_input {
        return Err(AppError::Message("Image input is disabled for this service/model. Enable it in Provider settings only if supported, or remove draft images and exclude image messages from history (Include next / No history). No request was sent.".into()));
    }
    let image_url_bytes: usize = args
        .images
        .iter()
        .chain(history.iter().flat_map(|m| &m.images))
        .map(|i| i.data_url.len())
        .sum();
    if image_url_bytes > crate::images::MAX_REQUEST_IMAGE_URL_BYTES {
        return Err(AppError::Message("Too many image bytes in this request. Exclude older image messages from history or use No history.".into()));
    }
    let workspace = compile_workspace(db, &args.conversation_id, &provider.context_separator)?;

    let mut system = provider.system_text.clone();
    append_part(&mut system, &workspace.system, &provider.context_separator);

    let mut messages = Vec::new();
    if !workspace.before_history.is_empty() {
        messages.push(CanonicalMessage {
            reasoning_content: None,
            intervention_call_id: None,
            role: "user".into(),
            content: workspace.before_history.clone(),
            images: Vec::new(),
        });
    }
    for message in &history {
        messages.push(history_message(message)?);
    }

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
    if current.is_empty() && args.images.is_empty() {
        return Err(AppError::Message(
            "request has no current user content".into(),
        ));
    }
    messages.push(CanonicalMessage {
        reasoning_content: None,
        intervention_call_id: None,
        role: "user".into(),
        content: current,
        images: args.images.clone(),
    });

    let messages = interleave_history(messages)?;
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
        image_count,
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

// Native plaintext replay is for raw-reasoning providers (DeepSeek/Kimi/GLM),
// not OpenAI encrypted state or signed Anthropic/Gemini blocks.
fn history_message(message: &crate::models::Message) -> AppResult<CanonicalMessage> {
    let mut result = CanonicalMessage {
        role: message.role.clone(),
        content: message.content.clone(),
        images: message.images.clone(),
        reasoning_content: None,
        intervention_call_id: None,
    };
    if message.role != "assistant" {
        return Ok(result);
    }
    let Some(reasoning) = &message.reasoning else {
        return Ok(result);
    };
    let selected: Vec<_> = reasoning
        .parts
        .iter()
        .filter(|p| p.include_next && !p.text.is_empty())
        .collect();
    let raw: String = selected
        .iter()
        .filter(|p| p.kind == "text")
        .map(|p| p.text.as_str())
        .collect();
    if reasoning.replay_mode != ReasoningReplayMode::Text && !raw.is_empty() {
        result.reasoning_content = Some(raw);
    }
    let mut notes = Vec::new();
    for part in &selected {
        if reasoning.replay_mode == ReasoningReplayMode::Text || part.kind == "summary" {
            let label = if part.kind == "summary" {
                "Selected reasoning summary"
            } else {
                "Assistant working notes"
            };
            notes.push(format!("[{label}]\n{}\n[/{label}]", part.text));
        }
    }
    if !message.content.is_empty() {
        notes.push(message.content.clone());
    }
    result.content = notes.join("\n\n");
    if reasoning.replay_mode == ReasoningReplayMode::Interleaved && !selected.is_empty() {
        if result.reasoning_content.is_none()
            || reasoning.encrypted
            || selected.iter().any(|p| p.kind != "text")
        {
            return Err(AppError::Message("Interleaved mock requires raw reasoning text without protected state or summaries. Choose Native raw or Assistant notes.".into()));
        }
        result.intervention_call_id = Some(format!("call_cera_{}", message.id.replace('-', "")));
    }
    Ok(result)
}

fn history_content(message: &crate::models::Message) -> String {
    // A display/estimate helper; compile propagates validation errors above.
    history_message(message)
        .map(|m| audit_message(&m))
        .unwrap_or_else(|_| message.content.clone())
}

fn interleave_history(messages: Vec<CanonicalMessage>) -> AppResult<Vec<CanonicalMessage>> {
    let mut result = Vec::new();
    let mut messages = messages.into_iter().peekable();
    while let Some(message) = messages.next() {
        let call_id = message.intervention_call_id.clone();
        let assistant = message.role == "assistant";
        result.push(message);
        if let Some(call_id) = call_id.filter(|_| assistant) {
            let intervention = if messages.peek().is_some_and(|m| m.role == "user") {
                let next = messages.next().unwrap();
                if !next.images.is_empty() {
                    return Err(AppError::Message("Interleaved mock supports text interventions only. Choose Native raw to send images.".into()));
                }
                next.content
            } else {
                "Continue.".into()
            };
            result.push(CanonicalMessage {
                role: "tool".into(),
                content: intervention,
                images: Vec::new(),
                reasoning_content: None,
                intervention_call_id: Some(call_id),
            });
        }
    }
    Ok(result)
}

const INTERVENTION_NAME: &str = "cerachat_intervention";
const INTERVENTION_DESCRIPTION: &str = "Pause the current work for operator feedback. The result contains the next user intervention. Continue the work using that feedback.";

fn add_mock_tools(body: &mut Map<String, Value>, request: &CanonicalRequest, responses: bool) {
    if !request
        .messages
        .iter()
        .any(|m| m.intervention_call_id.is_some())
    {
        return;
    }
    let function = serde_json::json!({"name": INTERVENTION_NAME, "description": INTERVENTION_DESCRIPTION, "parameters": {"type": "object", "properties": {}, "additionalProperties": false}});
    let tool = if responses {
        let mut tool = function.as_object().unwrap().clone();
        tool.insert("type".into(), Value::String("function".into()));
        Value::Object(tool)
    } else {
        serde_json::json!({"type": "function", "function": function})
    };
    body.insert("tools".into(), serde_json::json!([tool]));
    // This is a historical mock pair, not a live tool execution loop.
    body.insert("tool_choice".into(), Value::String("none".into()));
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
    for message in &request.messages {
        let mut item =
            serde_json::json!({ "role": message.role, "content": message_content(message, false) });
        if let Some(reasoning) = &message.reasoning_content {
            item["reasoning_content"] = Value::String(reasoning.clone());
        }
        if let Some(id) = &message.intervention_call_id {
            if message.role == "tool" {
                item["tool_call_id"] = Value::String(id.clone());
            } else {
                item["tool_calls"] = serde_json::json!([{ "id": id, "type": "function", "function": {"name": INTERVENTION_NAME, "arguments": "{}"} }]);
            }
        }
        messages.push(item);
    }
    add_mock_tools(&mut body, request, false);
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

fn message_content(message: &CanonicalMessage, responses: bool) -> Value {
    if message.images.is_empty() {
        return Value::String(message.content.clone());
    }
    let mut parts = Vec::new();
    if !message.content.is_empty() {
        parts.push(serde_json::json!({"type": if responses { "input_text" } else { "text" }, "text": message.content}));
    }
    for image in &message.images {
        parts.push(if responses {
            serde_json::json!({"type": "input_image", "image_url": image.data_url})
        } else {
            serde_json::json!({"type": "image_url", "image_url": {"url": image.data_url}})
        });
    }
    Value::Array(parts)
}

pub fn responses_request_json(request: &CanonicalRequest) -> AppResult<String> {
    let mut body = Map::new();
    body.insert("model".into(), Value::String(request.model.clone()));
    if let Some(system) = &request.system {
        body.insert("instructions".into(), Value::String(system.clone()));
    }
    let mut input = Vec::new();
    for message in &request.messages {
        if message.role == "tool" {
            input.push(serde_json::json!({"type": "function_call_output", "call_id": message.intervention_call_id, "output": message.content}));
            continue;
        }
        if let Some(reasoning) = &message.reasoning_content {
            input.push(serde_json::json!({"type": "reasoning", "content": [{"type": "reasoning_text", "text": reasoning}]}));
        }
        if !message.content.is_empty()
            || !message.images.is_empty()
            || message.intervention_call_id.is_none()
        {
            input.push(serde_json::json!({ "role": message.role, "content": message_content(message, true) }));
        }
        if let Some(id) = &message.intervention_call_id {
            input.push(serde_json::json!({"type": "function_call", "call_id": id, "name": INTERVENTION_NAME, "arguments": "{}"}));
        }
    }
    add_mock_tools(&mut body, request, true);
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
        output.push_str(&audit_message(message));
        output.push('\n');
    }
    output
}

fn audit_message(message: &CanonicalMessage) -> String {
    let mut output = format!("[{}]\n", message.role);
    if let Some(reasoning) = &message.reasoning_content {
        output.push_str(&format!(
            "[reasoning_content]\n{reasoning}\n[/reasoning_content]\n"
        ));
    }
    output.push_str(&message.content);
    if let Some(id) = &message.intervention_call_id {
        output.push_str(&format!(
            "\n[{}: {id}]",
            if message.role == "tool" {
                "tool_result"
            } else {
                INTERVENTION_NAME
            }
        ));
    }
    for image in &message.images {
        output.push_str(&format!("\n[image: {}]", image.name));
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
            image_input: false,
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
            images: Vec::new(),
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
                images: Vec::new(),
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
            images: Vec::new(),
            conversation_id: conversation.id,
            parent_id: Some(reply.id.clone()),
            input: "next".into(),
            history_mode: "full".into(),
            since_message_id: None,
        };
        let mut provider = ProviderConfig {
            image_input: false,
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
            both.compiled_prompt.find("visible steps").unwrap()
                < both.compiled_prompt.find("visible summary").unwrap()
        );
        assert!(
            both.compiled_prompt.find("visible steps").unwrap()
                < both.compiled_prompt.find("answer").unwrap()
        );
    }

    #[test]
    fn images_persist_in_branches_and_exact_snapshots_and_respect_model_and_history_settings() {
        let dir = std::env::temp_dir().join(format!("cerachat-images-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("chat.db");
        let db = Database::open(db_path.clone()).unwrap();
        let conversation = chat::create_conversation(&db).unwrap();
        let images = vec![crate::models::ImageAttachment {
            name: "sample.png".into(),
            data_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=".into(),
        }];
        let user = chat::insert_message_with_images(
            &db,
            &conversation.id,
            None,
            "user",
            "Original",
            &images,
        )
        .unwrap();
        let edited = chat::edit_message(&db, &user.id, "Edited").unwrap();
        let image_only = chat::edit_message(&db, &edited.id, "").unwrap();
        assert_eq!(image_only.images, images);
        assert_eq!(
            chat::get_message(&db, &user.id).unwrap().unwrap().content,
            "Original"
        );
        let mut provider = ProviderConfig {
            image_input: true,
            id: "custom-service".into(),
            name: "Custom".into(),
            protocol: "openai_chat_completions".into(),
            base_url: "http://unused.invalid".into(),
            api_key: String::new(),
            api_key_storage: "plain_portable".into(),
            model: "arbitrary-id".into(),
            context_window: 4096,
            max_output_tokens: 512,
            system_text: String::new(),
            temperature: None,
            raw_json_overrides: "{}".into(),
            context_separator: "---".into(),
        };
        let mut args = CompileRequestArgs {
            images: images.clone(),
            conversation_id: conversation.id.clone(),
            parent_id: None,
            input: String::new(),
            history_mode: "full".into(),
            since_message_id: None,
        };
        for protocol in ["openai_chat_completions", "openai_responses"] {
            provider.protocol = protocol.into();
            let compiled = compile(&db, &provider, &args).unwrap();
            let body: Value = serde_json::from_str(&compiled.request_json).unwrap();
            let (messages, kind) = if protocol == "openai_responses" {
                (&body["input"], "input_image")
            } else {
                (&body["messages"], "image_url")
            };
            assert_eq!(messages[0]["content"][0]["type"], kind);
            assert!(compiled.request_json.contains(&images[0].data_url));
            assert_eq!(compiled.breakdown.image_count, 1);
            assert_eq!(compiled.breakdown.estimated_input_tokens, 0);
            assert!(compiled.compiled_prompt.contains("[image: sample.png]"));
            assert_eq!(
                compiled.request_sha256,
                hex::encode(Sha256::digest(compiled.request_json.as_bytes()))
            );
        }
        let original = compile(&db, &provider, &args).unwrap();
        crate::db::request::insert_request_log(
            &db,
            "snapshot",
            &conversation.id,
            &user.id,
            &original,
        )
        .unwrap();
        args.images.clear();
        args.input = "Follow up".into();
        args.parent_id = Some(edited.id.clone());
        let follow_up = compile(&db, &provider, &args).unwrap();
        assert_eq!(follow_up.breakdown.image_count, 1);
        assert!(follow_up.request_json.contains("Edited"));
        provider.image_input = false;
        assert!(compile(&db, &provider, &args)
            .unwrap_err()
            .to_string()
            .contains("Image input is disabled"));
        args.history_mode = "no_history".into();
        assert!(!compile(&db, &provider, &args)
            .unwrap()
            .request_json
            .contains(&images[0].data_url));
        args.history_mode = "full".into();
        chat::set_message_included(&db, &edited.id, false).unwrap();
        assert_eq!(
            compile(&db, &provider, &args)
                .unwrap()
                .breakdown
                .image_count,
            0
        );
        let snapshot: String = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT actual_request_json FROM request_logs WHERE id='snapshot'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(snapshot, original.request_json);
        drop(db);
        let reopened = Database::open(db_path).unwrap();
        assert_eq!(
            chat::get_message(&reopened, &edited.id)
                .unwrap()
                .unwrap()
                .images,
            images
        );
        drop(reopened);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn raw_reasoning_and_intervention_pairs_use_native_fields_in_both_protocols() {
        let raw = "  working\n日本語\n";
        let message = crate::models::Message {
            id: "one-two".into(), conversation_id: "chat".into(), parent_id: None,
            role: "assistant".into(), content: "".into(), images: vec![], include_next: true, created_at: 1,
            reasoning: Some(serde_json::from_value(serde_json::json!({
                "parts": [{"id":"a", "kind":"text", "text":raw, "include_next":true}, {"id":"b", "kind":"text", "text":"more", "include_next":true}],
                "tokens":10, "encrypted":false
            })).unwrap()),
        };
        let native = history_message(&message).unwrap();
        assert_eq!(
            native.reasoning_content.as_deref(),
            Some(format!("{raw}more").as_str())
        );
        assert!(native.content.is_empty());
        assert!(native.intervention_call_id.is_none());
        let mut mock = message.clone();
        mock.reasoning.as_mut().unwrap().replay_mode = ReasoningReplayMode::Interleaved;
        let intervention = CanonicalMessage {
            role: "user".into(),
            content: "Change course 日本語".into(),
            images: vec![],
            reasoning_content: None,
            intervention_call_id: None,
        };
        let messages =
            interleave_history(vec![history_message(&mock).unwrap(), intervention]).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1].role, "tool");
        assert_eq!(
            messages[0].intervention_call_id,
            messages[1].intervention_call_id
        );
        let request = CanonicalRequest {
            model: "raw-model".into(),
            system: None,
            messages,
            temperature: None,
            max_output_tokens: 100,
            extra: Map::new(),
        };
        let chat: Value = serde_json::from_str(&openai_request_json(&request).unwrap()).unwrap();
        assert_eq!(
            chat["messages"][0]["reasoning_content"],
            format!("{raw}more")
        );
        assert_eq!(chat["messages"][0]["content"], "");
        assert_eq!(chat["messages"][1]["content"], "Change course 日本語");
        assert_eq!(
            chat["messages"][0]["tool_calls"][0]["id"],
            chat["messages"][1]["tool_call_id"]
        );
        assert_eq!(chat["tool_choice"], "none");
        let responses: Value =
            serde_json::from_str(&responses_request_json(&request).unwrap()).unwrap();
        assert_eq!(responses["input"][0]["type"], "reasoning");
        assert_eq!(
            responses["input"][0]["content"][0]["text"],
            format!("{raw}more")
        );
        assert_eq!(responses["input"][1]["type"], "function_call");
        assert_eq!(responses["input"][2]["type"], "function_call_output");
        assert_eq!(
            responses["input"][1]["call_id"],
            responses["input"][2]["call_id"]
        );
        assert_eq!(responses["input"][2]["output"], "Change course 日本語");
        assert_eq!(responses["tool_choice"], "none");
        // Filtering out a user turn must never leave an orphan tool call.
        let filtered = interleave_history(vec![history_message(&mock).unwrap()]).unwrap();
        assert_eq!(filtered[1].content, "Continue.");
        mock.reasoning.as_mut().unwrap().encrypted = true;
        assert!(history_message(&mock).is_err());
        mock.reasoning.as_mut().unwrap().encrypted = false;
        mock.reasoning.as_mut().unwrap().parts[0].kind = "summary".into();
        assert!(history_message(&mock).is_err());
        mock.reasoning.as_mut().unwrap().replay_mode = ReasoningReplayMode::Text;
        assert!(history_message(&mock).unwrap().reasoning_content.is_none());
    }

    #[test]
    fn rejects_tool_overrides() {
        assert!(parse_overrides(r#"{"tools": []}"#).is_err());
        assert!(parse_overrides(r#"{"reasoning_effort": "high"}"#).is_ok());
    }
}
