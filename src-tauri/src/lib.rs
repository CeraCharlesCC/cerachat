mod context;
mod db;
mod error;
mod models;
mod portable;
mod providers;
mod stream;

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use db::Database;
use models::{AddSliceArgs, CompileRequestArgs, StreamPayload, UpdateSliceArgs};

struct AppState {
    db: Arc<Database>,
}

fn command_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn data_dir(db: &Database) -> &std::path::Path {
    db.path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
}

#[tauri::command]
fn bootstrap(state: State<'_, AppState>) -> Result<models::BootstrapState, String> {
    db::chat::ensure_conversation(&state.db).map_err(command_error)?;
    Ok(models::BootstrapState {
        conversations: db::chat::list_conversations(&state.db).map_err(command_error)?,
        provider: portable::settings::load(data_dir(&state.db)).map_err(command_error)?,
        sources: db::context::list_sources(&state.db).map_err(command_error)?,
        slices: db::context::list_slices(&state.db).map_err(command_error)?,
        data_dir: data_dir(&state.db).display().to_string(),
    })
}

#[tauri::command]
fn get_messages(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<models::Message>, String> {
    db::chat::get_messages(&state.db, &conversation_id).map_err(command_error)
}

#[tauri::command]
fn create_conversation(state: State<'_, AppState>) -> Result<models::Conversation, String> {
    db::chat::create_conversation(&state.db).map_err(command_error)
}

#[tauri::command]
fn delete_conversation(state: State<'_, AppState>, conversation_id: String) -> Result<(), String> {
    db::chat::delete_conversation(&state.db, &conversation_id).map_err(command_error)
}

#[tauri::command]
fn set_message_included(
    state: State<'_, AppState>,
    message_id: String,
    included: bool,
) -> Result<(), String> {
    db::chat::set_message_included(&state.db, &message_id, included).map_err(command_error)
}

#[tauri::command]
fn delete_branch(state: State<'_, AppState>, message_id: String) -> Result<(), String> {
    db::chat::delete_branch(&state.db, &message_id).map_err(command_error)
}

#[tauri::command]
fn import_sources(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<models::WorkspaceSource>, String> {
    context::import_paths(&state.db, &paths).map_err(command_error)
}

#[tauri::command]
fn remove_source(state: State<'_, AppState>, source_id: String) -> Result<(), String> {
    db::context::remove_source(&state.db, &source_id).map_err(command_error)
}

#[tauri::command]
fn get_source_lines(
    state: State<'_, AppState>,
    source_id: String,
    start_line: usize,
    count: usize,
) -> Result<models::SourceLines, String> {
    db::context::source_lines(&state.db, &source_id, start_line, count).map_err(command_error)
}

#[tauri::command]
fn add_context_slice(
    state: State<'_, AppState>,
    args: AddSliceArgs,
) -> Result<models::ContextSlice, String> {
    db::context::add_slice(&state.db, args).map_err(command_error)
}

#[tauri::command]
fn update_context_slice(state: State<'_, AppState>, args: UpdateSliceArgs) -> Result<(), String> {
    db::context::update_slice(&state.db, args).map_err(command_error)
}

#[tauri::command]
fn delete_context_slice(state: State<'_, AppState>, slice_id: String) -> Result<(), String> {
    db::context::delete_slice(&state.db, &slice_id).map_err(command_error)
}

#[tauri::command]
fn save_provider(
    state: State<'_, AppState>,
    provider: models::ProviderConfig,
) -> Result<(), String> {
    // Saving provider settings is intentionally local-only: no validation or model-fetch request.
    portable::settings::save(data_dir(&state.db), &provider).map_err(command_error)
}

#[tauri::command]
fn compile_request(
    state: State<'_, AppState>,
    args: CompileRequestArgs,
) -> Result<models::RequestPreview, String> {
    let provider = portable::settings::load(data_dir(&state.db)).map_err(command_error)?;
    let compiled =
        context::compiler::compile(&state.db, &provider, &args).map_err(command_error)?;
    Ok(models::RequestPreview {
        request_json: compiled.request_json,
        compiled_prompt: compiled.compiled_prompt,
        request_sha256: compiled.request_sha256,
        breakdown: compiled.breakdown,
    })
}

#[tauri::command]
async fn send_message(
    app: AppHandle,
    state: State<'_, AppState>,
    args: CompileRequestArgs,
) -> Result<String, String> {
    let provider = portable::settings::load(data_dir(&state.db)).map_err(command_error)?;
    let compiled =
        context::compiler::compile(&state.db, &provider, &args).map_err(command_error)?;
    let user_message = db::chat::insert_message(
        &state.db,
        &args.conversation_id,
        args.parent_id.as_deref(),
        "user",
        &args.input,
    )
    .map_err(command_error)?;
    let request_id = Uuid::new_v4().to_string();
    db::request::insert_request_log(
        &state.db,
        &request_id,
        &args.conversation_id,
        &user_message.id,
        &compiled,
    )
    .map_err(command_error)?;

    let _ = app.emit(
        "chat-stream",
        StreamPayload {
            request_id: request_id.clone(),
            conversation_id: args.conversation_id.clone(),
            kind: "started".into(),
            text: None,
            error: None,
            assistant_message: None,
            user_message: Some(user_message.clone()),
        },
    );

    let db = state.db.clone();
    let app_handle = app.clone();
    let request_id_for_task = request_id.clone();
    let conversation_id = args.conversation_id.clone();
    let request_json = compiled.request_json.clone();
    tauri::async_runtime::spawn(async move {
        let result = providers::openai_compatible::stream_once(&provider, request_json, |delta| {
            let _ = app_handle.emit(
                "chat-stream",
                StreamPayload {
                    request_id: request_id_for_task.clone(),
                    conversation_id: conversation_id.clone(),
                    kind: "delta".into(),
                    text: Some(delta.to_string()),
                    error: None,
                    assistant_message: None,
                    user_message: None,
                },
            );
            Ok(())
        })
        .await;

        match result {
            Ok(output) => match db::chat::insert_message(
                &db,
                &conversation_id,
                Some(&user_message.id),
                "assistant",
                &output,
            ) {
                Ok(assistant) => {
                    let _ = db::request::attach_assistant(&db, &request_id_for_task, &assistant.id);
                    let _ = app_handle.emit(
                        "chat-stream",
                        StreamPayload {
                            request_id: request_id_for_task,
                            conversation_id,
                            kind: "done".into(),
                            text: None,
                            error: None,
                            assistant_message: Some(assistant),
                            user_message: None,
                        },
                    );
                }
                Err(error) => {
                    let _ = app_handle.emit(
                        "chat-stream",
                        StreamPayload {
                            request_id: request_id_for_task,
                            conversation_id,
                            kind: "error".into(),
                            text: None,
                            error: Some(error.to_string()),
                            assistant_message: None,
                            user_message: None,
                        },
                    );
                }
            },
            Err(error) => {
                let _ = app_handle.emit(
                    "chat-stream",
                    StreamPayload {
                        request_id: request_id_for_task,
                        conversation_id,
                        kind: "error".into(),
                        text: None,
                        error: Some(error.to_string()),
                        assistant_message: None,
                        user_message: None,
                    },
                );
            }
        }
    });

    Ok(request_id)
}

pub fn run() {
    let data = portable::paths::data_dir().expect("data directory");
    let db = Database::open(data.join("chat.sqlite3")).expect("database");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { db: Arc::new(db) })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            get_messages,
            create_conversation,
            delete_conversation,
            set_message_included,
            delete_branch,
            import_sources,
            remove_source,
            get_source_lines,
            add_context_slice,
            update_context_slice,
            delete_context_slice,
            save_provider,
            compile_request,
            send_message,
        ])
        .run(tauri::generate_context!())
        .expect("tauri error");
}
