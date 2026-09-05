pub mod chat;
pub mod context;
pub mod schema;

use std::{path::PathBuf, sync::Mutex};
use rusqlite::Connection;
use crate::error::AppResult;

pub struct Database {
    pub path: PathBuf,
    conn: Mutex<Connection>,
}

impl Database {
    pub fn open(path: PathBuf) -> AppResult<Self> {
        let conn = Connection::open(&path)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        schema::migrate(&conn)?;
        Ok(Self { path, conn: Mutex::new(conn) })
    }

    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let conn = self.conn.lock().expect("database mutex poisoned");
        f(&conn)
    }

    pub fn with_conn_mut<T>(&self, f: impl FnOnce(&mut Connection) -> AppResult<T>) -> AppResult<T> {
        let mut conn = self.conn.lock().expect("database mutex poisoned");
        f(&mut conn)
    }
}

pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}
