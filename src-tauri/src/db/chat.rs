use rusqlite::{params, OptionalExtension};
use uuid::Uuid;
use crate::db::{now_ms, Database};
use crate::error::{AppError, AppResult};
use crate::models::{Conversation, Message};

fn row_conversation(row: &rusqlite::Row<'_>) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: row.get(0)?,
        title: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

fn row_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<Message> {
    Ok(Message {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        parent_id: row.get(2)?,
        role: row.get(3)?,
        content: row.get(4)?,
        include_next: row.get::<_, i64>(5)? != 0,
        created_at: row.get(6)?,
    })
}

pub fn list_conversations(db: &Database) -> AppResult<Vec<Conversation>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id,title,created_at,updated_at FROM conversations ORDER BY updated_at DESC",
        )?;
        Ok(stmt.query_map([], row_conversation)?.collect::<Result<Vec<_>, _>>()?)
    })
}

pub fn create_conversation(db: &Database) -> AppResult<Conversation> {
    let now = now_ms();
    let c = Conversation {
        id: Uuid::new_v4().to_string(),
        title: "New chat".into(),
        created_at: now,
        updated_at: now,
    };
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO conversations(id,title,created_at,updated_at) VALUES(?1,?2,?3,?4)",
            params![c.id, c.title, c.created_at, c.updated_at],
        )?;
        Ok(())
    })?;
    Ok(c)
}

pub fn ensure_conversation(db: &Database) -> AppResult<Conversation> {
    if let Some(c) = list_conversations(db)?.into_iter().next() {
        return Ok(c);
    }
    create_conversation(db)
}

pub fn get_messages(db: &Database, conversation_id: &str) -> AppResult<Vec<Message>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id,conversation_id,parent_id,role,content,include_next,created_at FROM messages WHERE conversation_id=?1 ORDER BY created_at ASC",
        )?;
        Ok(stmt.query_map([conversation_id], row_message)?.collect::<Result<Vec<_>, _>>()?)
    })
}

pub fn get_message(db: &Database, id: &str) -> AppResult<Option<Message>> {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT id,conversation_id,parent_id,role,content,include_next,created_at FROM messages WHERE id=?1",
            [id],
            row_message,
        ).optional()?)
    })
}
