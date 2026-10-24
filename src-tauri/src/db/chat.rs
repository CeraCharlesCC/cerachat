use rusqlite::{params, OptionalExtension};
use uuid::Uuid;

use crate::db::{now_ms, Database};
use crate::error::{AppError, AppResult};
use crate::models::{Conversation, ImageAttachment, Message, Reasoning};

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
        images: serde_json::from_str(&row.get::<_, String>(8)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                8,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        include_next: row.get::<_, i64>(5)? != 0,
        created_at: row.get(6)?,
        reasoning: row
            .get::<_, Option<String>>(7)?
            .map(|json| {
                serde_json::from_str(&json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        7,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
            })
            .transpose()?,
    })
}

pub fn list_conversations(db: &Database) -> AppResult<Vec<Conversation>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id,title,created_at,updated_at FROM conversations ORDER BY updated_at DESC",
        )?;
        let conversations = stmt
            .query_map([], row_conversation)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(conversations)
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
            params![
                conversation.id,
                conversation.title,
                conversation.created_at,
                conversation.updated_at
            ],
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
            "SELECT id,conversation_id,parent_id,role,content,include_next,created_at,reasoning_json,images_json
             FROM messages WHERE conversation_id=?1 ORDER BY created_at ASC, id ASC",
        )?;
        let messages = stmt
            .query_map([conversation_id], row_message)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(messages)
    })
}

pub fn get_message(db: &Database, id: &str) -> AppResult<Option<Message>> {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT id,conversation_id,parent_id,role,content,include_next,created_at,reasoning_json,images_json FROM messages WHERE id=?1",
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
    insert_message_with_reasoning(db, conversation_id, parent_id, role, content, None)
}

pub fn insert_message_with_reasoning(
    db: &Database,
    conversation_id: &str,
    parent_id: Option<&str>,
    role: &str,
    content: &str,
    reasoning: Option<Reasoning>,
) -> AppResult<Message> {
    insert_message_full(
        db,
        conversation_id,
        parent_id,
        role,
        content,
        reasoning,
        &[],
    )
}

pub fn insert_message_with_images(
    db: &Database,
    conversation_id: &str,
    parent_id: Option<&str>,
    role: &str,
    content: &str,
    images: &[ImageAttachment],
) -> AppResult<Message> {
    if images.is_empty() {
        insert_message(db, conversation_id, parent_id, role, content)
    } else {
        insert_message_full(db, conversation_id, parent_id, role, content, None, images)
    }
}

fn insert_message_full(
    db: &Database,
    conversation_id: &str,
    parent_id: Option<&str>,
    role: &str,
    content: &str,
    reasoning: Option<Reasoning>,
    images: &[ImageAttachment],
) -> AppResult<Message> {
    crate::images::validate(images)?;
    if role != "user" && !images.is_empty() {
        return Err(AppError::Message(
            "images can only be attached to user messages".into(),
        ));
    }
    if !matches!(role, "user" | "assistant") {
        return Err(AppError::Message("invalid message role".into()));
    }
    if let Some(parent_id) = parent_id {
        let parent = get_message(db, parent_id)?
            .ok_or_else(|| AppError::Message("parent message not found".into()))?;
        if parent.conversation_id != conversation_id {
            return Err(AppError::Message(
                "parent message belongs to another conversation".into(),
            ));
        }
    }

    let now = now_ms();
    let message = Message {
        id: Uuid::new_v4().to_string(),
        conversation_id: conversation_id.to_string(),
        parent_id: parent_id.map(str::to_string),
        role: role.to_string(),
        content: content.to_string(),
        reasoning,
        images: images.to_vec(),
        include_next: true,
        created_at: now,
    };

    db.with_conn_mut(|conn| {
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO messages(id,conversation_id,parent_id,role,content,include_next,created_at,reasoning_json,images_json) VALUES(?1,?2,?3,?4,?5,1,?6,?7,?8)",
            params![message.id, message.conversation_id, message.parent_id, message.role, message.content, message.created_at, message.reasoning.as_ref().map(serde_json::to_string).transpose()?, serde_json::to_string(&message.images)?],
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

pub fn set_reasoning_part_included(
    db: &Database,
    message_id: &str,
    part_id: &str,
    included: bool,
) -> AppResult<()> {
    db.with_conn_mut(|conn| {
        let tx = conn.transaction()?;
        let mut message = tx.query_row(
            "SELECT id,conversation_id,parent_id,role,content,include_next,created_at,reasoning_json,images_json FROM messages WHERE id=?1",
            [message_id], row_message,
        ).optional()?.ok_or_else(|| AppError::Message("message not found".into()))?;
        if message.role != "assistant" {
            return Err(AppError::Message("reasoning requires an assistant message".into()));
        }
        let reasoning = message.reasoning.as_mut().ok_or_else(|| AppError::Message("reasoning block not found".into()))?;
        let part = reasoning.parts.iter_mut().find(|part| part.id == part_id)
            .ok_or_else(|| AppError::Message("reasoning block not found".into()))?;
        if included && part.text.is_empty() {
            return Err(AppError::Message("reasoning block has no visible text".into()));
        }
        part.include_next = included;
        tx.execute("UPDATE messages SET reasoning_json=?2 WHERE id=?1", params![message_id, serde_json::to_string(reasoning)?])?;
        tx.commit()?;
        Ok(())
    })
}

/// Editing creates a sibling; existing descendants and request snapshots stay intact.
#[cfg(test)]
pub fn edit_message(db: &Database, message_id: &str, content: &str) -> AppResult<Message> {
    edit_message_with_reasoning(db, message_id, content, None)
}

pub fn edit_message_with_reasoning(
    db: &Database,
    message_id: &str,
    content: &str,
    reasoning: Option<Reasoning>,
) -> AppResult<Message> {
    db.with_conn_mut(|conn| {
        let tx = conn.transaction()?;
        let original = tx.query_row(
            "SELECT id,conversation_id,parent_id,role,content,include_next,created_at,reasoning_json,images_json FROM messages WHERE id=?1",
            [message_id], row_message,
        ).optional()?.ok_or_else(|| AppError::Message("message not found".into()))?;
        let mut reasoning = reasoning.or_else(|| (original.content == content).then(|| original.reasoning.clone()).flatten());
        if reasoning != original.reasoning {
            if let Some(reasoning) = &mut reasoning {
                reasoning.tokens = None;
                reasoning.encrypted = false;
                reasoning.edited = true;
            }
        }
        if reasoning.as_ref().is_some_and(|r| r.parts.is_empty()) { reasoning = None; }
        if reasoning.is_some() && original.role != "assistant" {
            return Err(AppError::Message("reasoning requires an assistant message".into()));
        }
        if let Some(reasoning) = &reasoning {
            let mut ids = std::collections::HashSet::new();
            if reasoning.parts.iter().any(|p| p.id.is_empty() || !ids.insert(&p.id) || !matches!(p.kind.as_str(), "text" | "summary")) {
                return Err(AppError::Message("invalid reasoning blocks".into()));
            }
        }
        if content.trim().is_empty() && original.images.is_empty() && !reasoning.as_ref().is_some_and(|r| r.parts.iter().any(|p| !p.text.trim().is_empty())) {
            return Err(AppError::Message("message content cannot be empty".into()));
        }
        if original.content == content && reasoning == original.reasoning {
            return Ok(original);
        }
        let edited = Message {
            id: Uuid::new_v4().to_string(), content: content.to_string(), reasoning,
            created_at: now_ms(), ..original
        };
        tx.execute(
            "INSERT INTO messages(id,conversation_id,parent_id,role,content,include_next,created_at,images_json,reasoning_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![edited.id, edited.conversation_id, edited.parent_id, edited.role, edited.content, edited.include_next, edited.created_at, serde_json::to_string(&edited.images)?, edited.reasoning.as_ref().map(serde_json::to_string).transpose()?],
        )?;
        tx.execute("UPDATE conversations SET updated_at=?2 WHERE id=?1", params![edited.conversation_id, edited.created_at])?;
        tx.commit()?;
        Ok(edited)
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

pub fn branch_to(
    db: &Database,
    leaf_id: Option<&str>,
    conversation_id: &str,
) -> AppResult<Vec<Message>> {
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
            return Err(AppError::Message(
                "history parent belongs to another conversation".into(),
            ));
        }
        let parent = message.parent_id.clone();
        reversed.push(message);
        let Some(parent) = parent else { break };
        current_id = parent;
    }
    reversed.reverse();
    Ok(reversed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_reasoning_edits_branch_and_preserve_original_history() {
        let path =
            std::env::temp_dir().join(format!("cerachat-edit-reasoning-{}.db", Uuid::new_v4()));
        let db = Database::open(path.clone()).unwrap();
        let chat = create_conversation(&db).unwrap();
        let user = insert_message(&db, &chat.id, None, "user", "question").unwrap();
        let reasoning: Reasoning = serde_json::from_value(serde_json::json!({"parts":[{"id":"r", "kind":"text", "text":"original", "include_next":true}], "tokens":42, "encrypted":false})).unwrap();
        let original = insert_message_with_reasoning(
            &db,
            &chat.id,
            Some(&user.id),
            "assistant",
            "answer",
            Some(reasoning.clone()),
        )
        .unwrap();
        let child = insert_message(&db, &chat.id, Some(&original.id), "user", "follow up").unwrap();
        let mut draft = reasoning.clone();
        draft.parts[0].text = "edited 日本語\n".into();
        draft.replay_mode = crate::models::ReasoningReplayMode::Interleaved;
        let edited = edit_message_with_reasoning(&db, &original.id, "", Some(draft)).unwrap();
        assert_ne!(original.id, edited.id);
        assert_eq!(edited.parent_id, original.parent_id);
        assert!(edited.content.is_empty());
        assert_eq!(
            get_message(&db, &child.id)
                .unwrap()
                .unwrap()
                .parent_id
                .as_deref(),
            Some(original.id.as_str())
        );
        assert_eq!(
            get_message(&db, &original.id).unwrap().unwrap().reasoning,
            Some(reasoning)
        );
        let edited_reasoning = edited.reasoning.clone().unwrap();
        assert!(edited_reasoning.edited);
        assert!(!edited_reasoning.encrypted);
        assert_eq!(edited_reasoning.tokens, None);
        assert_eq!(
            edit_message_with_reasoning(&db, &edited.id, "", Some(edited_reasoning.clone()))
                .unwrap()
                .id,
            edited.id
        );
        drop(db);
        let db = Database::open(path.clone()).unwrap();
        assert_eq!(
            get_message(&db, &edited.id).unwrap().unwrap().reasoning,
            Some(edited_reasoning)
        );
        assert!(
            edit_message_with_reasoning(&db, &edited.id, "", Some(Reasoning::default())).is_err()
        );
        drop(db);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn reasoning_survives_reopening_but_is_cleared_on_edited_branches() {
        let path =
            std::env::temp_dir().join(format!("cerachat-reasoning-{}.sqlite3", Uuid::new_v4()));
        let db = Database::open(path.clone()).unwrap();
        let chat = create_conversation(&db).unwrap();
        let user = insert_message(&db, &chat.id, None, "user", "question").unwrap();
        let reasoning = Reasoning {
            parts: vec![crate::models::ReasoningPart {
                id: "summary-0".into(),
                kind: "summary".into(),
                text: "Saved summary 日本語".into(),
                include_next: false,
            }],
            tokens: Some(42),
            encrypted: true,
            ..Default::default()
        };
        let reply = insert_message_with_reasoning(
            &db,
            &chat.id,
            Some(&user.id),
            "assistant",
            "answer",
            Some(reasoning.clone()),
        )
        .unwrap();
        drop(db);
        let db = Database::open(path.clone()).unwrap();
        assert_eq!(
            get_message(&db, &reply.id).unwrap().unwrap().reasoning,
            Some(reasoning.clone())
        );
        assert!(get_message(&db, &user.id)
            .unwrap()
            .unwrap()
            .reasoning
            .is_none());
        assert_eq!(
            edit_message(&db, &reply.id, "answer").unwrap().reasoning,
            Some(reasoning.clone())
        );
        assert!(set_reasoning_part_included(&db, "missing", "summary-0", true).is_err());
        assert!(set_reasoning_part_included(&db, &user.id, "summary-0", true).is_err());
        assert!(set_reasoning_part_included(&db, &reply.id, "missing", true).is_err());
        set_reasoning_part_included(&db, &reply.id, "summary-0", true).unwrap();
        let mut reasoning = reasoning;
        reasoning.parts[0].include_next = true;
        drop(db);
        let db = Database::open(path.clone()).unwrap();
        assert_eq!(
            get_message(&db, &reply.id).unwrap().unwrap().reasoning,
            Some(reasoning.clone())
        );
        assert!(edit_message(&db, &reply.id, "edited")
            .unwrap()
            .reasoning
            .is_none());
        assert_eq!(
            branch_to(&db, Some(&reply.id), &chat.id).unwrap()[1].reasoning,
            Some(reasoning)
        );
        set_reasoning_part_included(&db, &reply.id, "summary-0", false).unwrap();
        assert!(
            !get_message(&db, &reply.id)
                .unwrap()
                .unwrap()
                .reasoning
                .unwrap()
                .parts[0]
                .include_next
        );
        drop(db);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn edits_preserve_original_subtree_and_inclusion_without_sending() {
        let db = Database::open(":memory:".into()).unwrap();
        let chat = create_conversation(&db).unwrap();
        let user = insert_message(&db, &chat.id, None, "user", "original").unwrap();
        let reply = insert_message(&db, &chat.id, Some(&user.id), "assistant", "reply").unwrap();
        set_message_included(&db, &user.id, false).unwrap();
        let edited = edit_message(&db, &user.id, "edited\n日本語").unwrap();
        assert_ne!(edited.id, user.id);
        assert_eq!(edited.parent_id, user.parent_id);
        assert_eq!(edited.role, "user");
        assert!(!edited.include_next);
        assert_eq!(
            get_message(&db, &user.id).unwrap().unwrap().content,
            "original"
        );
        assert_eq!(
            get_message(&db, &reply.id).unwrap().unwrap().parent_id,
            Some(user.id.clone())
        );
        let edited_reply = edit_message(&db, &reply.id, "alternative reply").unwrap();
        assert_eq!(edited_reply.parent_id.as_deref(), Some(user.id.as_str()));
        assert_eq!(edited_reply.role, "assistant");
        assert_eq!(branch_to(&db, Some(&edited.id), &chat.id).unwrap().len(), 1);
        assert_eq!(branch_to(&db, Some(&reply.id), &chat.id).unwrap().len(), 2);
        assert_eq!(
            edit_message(&db, &edited.id, &edited.content).unwrap().id,
            edited.id
        );
        assert!(edit_message(&db, &user.id, " \n").is_err());
        assert!(edit_message(&db, "missing", "text").is_err());
        assert_eq!(get_messages(&db, &chat.id).unwrap().len(), 4);
        delete_branch(&db, &edited.id).unwrap();
        assert!(get_message(&db, &reply.id).unwrap().is_some());
    }
}
