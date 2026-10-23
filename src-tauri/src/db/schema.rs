use crate::error::AppResult;
use rusqlite::Connection;

pub fn migrate(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(r#"
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  parent_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  include_next INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY(parent_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY, data BLOB NOT NULL, original_size INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_sources (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  origin_path TEXT NOT NULL,
  archive_path TEXT,
  blob_hash TEXT NOT NULL,
  line_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(blob_hash) REFERENCES blobs(hash)
);
CREATE INDEX IF NOT EXISTS idx_workspace_sources_blob ON workspace_sources(blob_hash);
CREATE TABLE IF NOT EXISTS context_slices (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  range_type TEXT NOT NULL CHECK (range_type IN ('all','lines','chars')),
  start_pos INTEGER,
  end_pos INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL,
  wrapper TEXT NOT NULL CHECK (wrapper IN ('raw','labeled')),
  insert_at TEXT NOT NULL CHECK (insert_at IN ('before_current','inside_current','before_history','system')),
  FOREIGN KEY(source_id) REFERENCES workspace_sources(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_context_slices_order ON context_slices(sort_order);

CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_message_id TEXT,
  assistant_message_id TEXT,
  request_sha256 TEXT NOT NULL,
  compiled_prompt TEXT NOT NULL,
  actual_request_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY(user_message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY(assistant_message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS request_context (
  request_id TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  PRIMARY KEY(request_id, blob_hash),
  FOREIGN KEY(request_id) REFERENCES request_logs(id) ON DELETE CASCADE,
  FOREIGN KEY(blob_hash) REFERENCES blobs(hash)
);
"#)?;
    // Legacy global sources have no reliable chat ownership. Keep them available
    // for explicit reuse without silently attaching them to any conversation.
    let has_owner = {
        let mut stmt = conn.prepare("PRAGMA table_info(workspace_sources)")?;
        let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
        columns
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|name| name == "conversation_id")
    };
    if !has_owner {
        conn.execute_batch("ALTER TABLE workspace_sources ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE;")?;
    }
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_workspace_sources_conversation ON workspace_sources(conversation_id);")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_preserves_legacy_library_and_adds_chat_ownership_once() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn.execute_batch("CREATE TABLE blobs (hash TEXT PRIMARY KEY, data BLOB NOT NULL, original_size INTEGER NOT NULL);
            CREATE TABLE workspace_sources (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, origin_path TEXT NOT NULL,
                archive_path TEXT, blob_hash TEXT NOT NULL, line_count INTEGER NOT NULL, created_at INTEGER NOT NULL,
                FOREIGN KEY(blob_hash) REFERENCES blobs(hash));
            INSERT INTO blobs VALUES('hash', X'00', 3);
            INSERT INTO workspace_sources VALUES('legacy', 'old.txt', 'paste', NULL, 'hash', 1, 1);").unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let legacy: (String, Option<String>) = conn
            .query_row(
                "SELECT display_name,conversation_id FROM workspace_sources WHERE id='legacy'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(legacy, ("old.txt".into(), None));
        conn.execute("INSERT INTO conversations VALUES('chat', 'Chat', 1, 1)", [])
            .unwrap();
        conn.execute(
            "UPDATE workspace_sources SET conversation_id='chat' WHERE id='legacy'",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM conversations WHERE id='chat'", [])
            .unwrap();
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspace_sources", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(remaining, 0);
    }
}
