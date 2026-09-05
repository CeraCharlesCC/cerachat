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
    let conversation = Conversation {
        id: Uuid::new_v4().to_string(),
        title: "New chat".into(),
        created_at: now,
        updated_at: now,
    };
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO conversations(id,title,created_at,updated_at) VALUES(?1,?2,?3,?4)",
            params![conversation.id, conversation.title, conversation.created_at, conversation.updated_at],
        )?;
        Ok(())
    })?;
    Ok(conversation)
}

pub fn ensure_conversation(db: &Database) -> AppResult<Conversation> {
    if let Some(conversation) = list_conversations(db)?.into_iter().next() {
        return Ok(conversation);
    }
    create_conversation(db)
}

pub fn get_messages(db: &Database, conversation_id: &str) -> AppResult<Vec<Message>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id,conversation_id,parent_id,role,content,include_next,created_at
             FROM messages WHERE conversation_id=?1 ORDER BY created_at ASC, id ASC",
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

pub fn insert_message(
    db: &Database,
    conversation_id: &str,
    parent_id: Option<&str>,
    role: &str,
    content: &str,
) -> AppResult<Message> {
    if !matches!(role, "user" | "assistant") {
        return Err(AppError::Message("invalid message role".into()));
    }
    if let Some(parent_id) = parent_id {
        let parent = get_message(db, parent_id)?
            .ok_or_else(|| AppError::Message("parent message not found".into()))?;
        if parent.conversation_id != conversation_id {
            return Err(AppError::Message("parent message belongs to another conversation".into()));
        }
    }

    let now = now_ms();
    let message = Message {
        id: Uuid::new_v4().to_string(),
        conversation_id: conversation_id.to_string(),
        parent_id: parent_id.map(str::to_string),
        role: role.to_string(),
        content: content.to_string(),
        include_next: true,
        created_at: now,
    };

    db.with_conn_mut(|conn| {
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO messages(id,conversation_id,parent_id,role,content,include_next,created_at) VALUES(?1,?2,?3,?4,?5,1,?6)",
            params![message.id, message.conversation_id, message.parent_id, message.role, message.content, message.created_at],
        )?;
        tx.execute(
            "UPDATE conversations SET updated_at=?2 WHERE id=?1",
            params![conversation_id, now],
        )?;
        if role == "user" {
            let current_title: Option<String> = tx
                .query_row("SELECT title FROM conversations WHERE id=?1", [conversation_id], |row| row.get(0))
                .optional()?;
            if current_title.as_deref() == Some("New chat") {
                let title: String = content.chars().take(50).collect();
                let title = if title.trim().is_empty() { "New chat".to_string() } else { title };
                tx.execute("UPDATE conversations SET title=?2 WHERE id=?1", params![conversation_id, title])?;
            }
        }
        tx.commit()?;
        Ok(())
    })?;
    Ok(message)
}

pub fn set_message_included(db: &Database, message_id: &str, included: bool) -> AppResult<()> {
    db.with_conn(|conn| {
        let changed = conn.execute(
            "UPDATE messages SET include_next=?2 WHERE id=?1",
            params![message_id, included as i64],
        )?;
        if changed == 0 {
            return Err(AppError::Message("message not found".into()));
        }
        Ok(())
    })
}

pub fn delete_conversation(db: &Database, conversation_id: &str) -> AppResult<()> {
    db.with_conn_mut(|conn| {
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM conversations WHERE id=?1", [conversation_id])?;
        crate::db::context::gc_unreferenced_blobs(&tx)?;
        tx.commit()?;
        Ok(())
    })
}

pub fn delete_branch(db: &Database, message_id: &str) -> AppResult<()> {
    db.with_conn_mut(|conn| {
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM messages WHERE id=?1", [message_id])?;
        crate::db::context::gc_unreferenced_blobs(&tx)?;
        tx.commit()?;
        Ok(())
    })
}

pub fn branch_to(db: &Database, leaf_id: Option<&str>, conversation_id: &str) -> AppResult<Vec<Message>> {
    let Some(mut current_id) = leaf_id.map(str::to_string) else {
        return Ok(Vec::new());
    };
    let mut reversed = Vec::new();
    let mut safety = 0usize;
    loop {
        safety += 1;
        if safety > 100_000 {
            return Err(AppError::Message("message parent cycle detected".into()));
        }
        let message = get_message(db, &current_id)?
            .ok_or_else(|| AppError::Message("history parent message not found".into()))?;
        if message.conversation_id != conversation_id {
            return Err(AppError::Message("history parent belongs to another conversation".into()));
        }
        let parent = message.parent_id.clone();
        reversed.push(message);
        let Some(parent) = parent else { break };
        current_id = parent;
    }
    reversed.reverse();
    Ok(reversed)
}
