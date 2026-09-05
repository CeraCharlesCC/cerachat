mod context;
mod db;
mod error;
mod models;
mod portable;
mod providers;
mod stream;

use std::sync::Arc;
use tauri::State;
use db::Database;
use error::AppResult;

struct AppState { db: Arc<Database> }

#[tauri::command]
fn bootstrap(state: State<'_, AppState>) -> Result<models::BootstrapState, String> {
    let c = db::chat::ensure_conversation(&state.db).map_err(|e| e.to_string())?;
    Ok(models::BootstrapState {
        conversations: vec![c],
        provider: models::ProviderConfig::default(),
        sources: vec![],
        slices: vec![],
        data_dir: state.db.path.parent().unwrap_or_else(|| std::path::Path::new(".")).display().to_string(),
    })
}

#[tauri::command]
fn get_messages(state: State<'_, AppState>, conversation_id: String) -> Result<Vec<models::Message>, String> {
    db::chat::get_messages(&state.db, &conversation_id).map_err(|e| e.to_string())
}

pub fn run() {
    let data = portable::paths::data_dir().expect("data directory");
    let db = Database::open(data.join("chat.sqlite3")).expect("database");
    tauri::Builder::default()
        .manage(AppState { db: Arc::new(db) })
        .invoke_handler(tauri::generate_handler![bootstrap, get_messages])
        .run(tauri::generate_context!())
        .expect("tauri error");
}
