use std::{collections::HashSet, io::Cursor};

use rusqlite::{params, OptionalExtension, Transaction};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    context::text::{estimate_tokens, line_count, slice_text},
    error::{AppError, AppResult},
    models::{AddSliceArgs, ContextSlice, SourceLines, UpdateSliceArgs, WorkspaceSource},
};

use super::{now_ms, Database};

fn row_source(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceSource> {
    Ok(WorkspaceSource {
        id: row.get(0)?,
        conversation_id: row.get(8)?,
        display_name: row.get(1)?,
        origin_path: row.get(2)?,
        archive_path: row.get(3)?,
        blob_hash: row.get(4)?,
        original_size: row.get(5)?,
        line_count: row.get(6)?,
        created_at: row.get(7)?,
    })
}

pub fn add_source(
    db: &Database,
    conversation_id: &str,
    display_name: String,
    origin_path: String,
    archive_path: Option<String>,
    text: &str,
) -> AppResult<WorkspaceSource> {
    let bytes = text.as_bytes();
    let hash = hex::encode(Sha256::digest(bytes));
    if let Some(existing) = list_sources(db)?.into_iter().find(|source| {
        source.conversation_id.as_deref() == Some(conversation_id)
            && source.blob_hash == hash
            && source.origin_path == origin_path
            && source.archive_path == archive_path
            && source.display_name == display_name
    }) {
        return Ok(existing);
    }
    let compressed = zstd::stream::encode_all(Cursor::new(bytes), 3)?;
    let source = WorkspaceSource {
        id: Uuid::new_v4().to_string(),
        conversation_id: Some(conversation_id.to_string()),
        display_name,
        origin_path,
        archive_path,
        blob_hash: hash.clone(),
        original_size: bytes.len() as i64,
        line_count: line_count(text),
        created_at: now_ms(),
    };

    db.with_conn_mut(|conn| {
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO blobs(hash,data,original_size) VALUES(?1,?2,?3)",
            params![hash, compressed, bytes.len() as i64],
        )?;
        tx.execute(
            "INSERT INTO workspace_sources(id,display_name,origin_path,archive_path,blob_hash,line_count,created_at,conversation_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                source.id,
                source.display_name,
                source.origin_path,
                source.archive_path,
                source.blob_hash,
                source.line_count,
                source.created_at,
                source.conversation_id,
            ],
        )?;
        tx.commit()?;
        Ok(())
    })?;
    Ok(source)
}

pub fn list_sources(db: &Database) -> AppResult<Vec<WorkspaceSource>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT ws.id,ws.display_name,ws.origin_path,ws.archive_path,ws.blob_hash,b.original_size,ws.line_count,ws.created_at,ws.conversation_id
             FROM workspace_sources ws JOIN blobs b ON b.hash=ws.blob_hash
             ORDER BY ws.created_at ASC",
        )?;
        let sources = stmt
            .query_map([], row_source)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(sources)
    })
}

/// Explicitly reuse a source in another chat; attachments remain independent.
pub fn reference_source(
    db: &Database,
    conversation_id: &str,
    source_id: &str,
) -> AppResult<WorkspaceSource> {
    let source = get_source(db, source_id)?
        .ok_or_else(|| AppError::Message("workspace source not found".into()))?;
    if let Some(existing) = list_sources(db)?.into_iter().find(|item| {
        item.conversation_id.as_deref() == Some(conversation_id)
            && item.blob_hash == source.blob_hash
            && item.display_name == source.display_name
            && item.origin_path == source.origin_path
            && item.archive_path == source.archive_path
    }) {
        return Ok(existing);
    }
    let referenced = WorkspaceSource {
        id: Uuid::new_v4().to_string(),
        conversation_id: Some(conversation_id.to_string()),
        created_at: now_ms(),
        ..source
    };
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO workspace_sources(id,display_name,origin_path,archive_path,blob_hash,line_count,created_at,conversation_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![referenced.id, referenced.display_name, referenced.origin_path, referenced.archive_path, referenced.blob_hash, referenced.line_count, referenced.created_at, referenced.conversation_id],
        )?;
        Ok(())
    })?;
    Ok(referenced)
}

pub fn get_source(db: &Database, source_id: &str) -> AppResult<Option<WorkspaceSource>> {
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT ws.id,ws.display_name,ws.origin_path,ws.archive_path,ws.blob_hash,b.original_size,ws.line_count,ws.created_at,ws.conversation_id
                 FROM workspace_sources ws JOIN blobs b ON b.hash=ws.blob_hash WHERE ws.id=?1",
                [source_id],
                row_source,
            )
            .optional()?)
    })
}

pub fn source_text(db: &Database, source_id: &str) -> AppResult<String> {
    db.with_conn(|conn| {
        let compressed: Vec<u8> = conn
            .query_row(
                "SELECT b.data FROM blobs b JOIN workspace_sources ws ON ws.blob_hash=b.hash WHERE ws.id=?1",
                [source_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::Message("workspace source not found".into()))?;
        let decoded = zstd::stream::decode_all(Cursor::new(compressed))?;
        String::from_utf8(decoded).map_err(|error| AppError::Message(format!("stored source is not UTF-8: {error}")))
    })
}

pub fn source_lines(
    db: &Database,
    source_id: &str,
    start_line: usize,
    count: usize,
) -> AppResult<SourceLines> {
    let source = get_source(db, source_id)?
        .ok_or_else(|| AppError::Message("workspace source not found".into()))?;
    let text = source_text(db, source_id)?;
    let start = start_line.max(1);
    let count = count.clamp(1, 500);
    let lines = if text.is_empty() {
        Vec::new()
    } else {
        text.split('\n')
            .skip(start - 1)
            .take(count)
            .map(str::to_string)
            .collect()
    };
    Ok(SourceLines {
        source_id: source_id.to_string(),
        start_line: start,
        total_lines: source.line_count.max(0) as usize,
        lines,
    })
}

pub fn remove_source(db: &Database, source_id: &str) -> AppResult<()> {
    db.with_conn_mut(|conn| {
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM workspace_sources WHERE id=?1", [source_id])?;
        gc_unreferenced_blobs(&tx)?;
        tx.commit()?;
        Ok(())
    })
}

fn row_slice_base(row: &rusqlite::Row<'_>) -> rusqlite::Result<(ContextSlice, String)> {
    Ok((
        ContextSlice {
            id: row.get(0)?,
            source_id: row.get(1)?,
            source_name: row.get(2)?,
            range_type: row.get(3)?,
            start_pos: row.get(4)?,
            end_pos: row.get(5)?,
            enabled: row.get::<_, i64>(6)? != 0,
            sort_order: row.get(7)?,
            wrapper: row.get(8)?,
            insert_at: row.get(9)?,
            estimated_tokens: 0,
        },
        row.get(10)?,
    ))
}

pub fn list_slices(db: &Database) -> AppResult<Vec<ContextSlice>> {
    query_slices(db, None)
}

pub fn conversation_slices(db: &Database, conversation_id: &str) -> AppResult<Vec<ContextSlice>> {
    query_slices(db, Some(conversation_id))
}

fn query_slices(db: &Database, conversation_id: Option<&str>) -> AppResult<Vec<ContextSlice>> {
    let rows: Vec<(ContextSlice, String)> = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT cs.id,cs.source_id,ws.display_name,cs.range_type,cs.start_pos,cs.end_pos,cs.enabled,cs.sort_order,cs.wrapper,cs.insert_at,ws.blob_hash
             FROM context_slices cs JOIN workspace_sources ws ON ws.id=cs.source_id WHERE (?1 IS NULL OR ws.conversation_id=?1) ORDER BY cs.sort_order ASC, cs.id ASC",
        )?;
        let rows = stmt
            .query_map([conversation_id], row_slice_base)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;

    rows.into_iter()
        .map(|(mut slice, _)| {
            let text = source_text(db, &slice.source_id)?;
            let selected = slice_text(&text, &slice.range_type, slice.start_pos, slice.end_pos)?;
            slice.estimated_tokens = estimate_tokens(&selected);
            Ok(slice)
        })
        .collect()
}

pub fn add_slice(db: &Database, args: AddSliceArgs) -> AppResult<ContextSlice> {
    if !matches!(args.range_type.as_str(), "all" | "lines" | "chars") {
        return Err(AppError::Message("invalid context range type".into()));
    }
    if !matches!(args.wrapper.as_str(), "raw" | "labeled") {
        return Err(AppError::Message("invalid context wrapper".into()));
    }
    if !matches!(
        args.insert_at.as_str(),
        "before_current" | "inside_current" | "before_history" | "system"
    ) {
        return Err(AppError::Message("invalid context insertion point".into()));
    }
    let source = get_source(db, &args.source_id)?
        .ok_or_else(|| AppError::Message("workspace source not found".into()))?;
    // Validate before writing: a failed range must never poison the workspace.
    let text = source_text(db, &source.id)?;
    let selected = slice_text(&text, &args.range_type, args.start_pos, args.end_pos)?;
    let (start_pos, end_pos) = if args.range_type == "all" {
        (None, None)
    } else {
        (args.start_pos, args.end_pos)
    };
    let (id, sort_order) = db.with_conn_mut(|conn| {
        let tx = conn.transaction()?;
        let existing: Option<(String, i64)> = tx.query_row(
            "SELECT id,sort_order FROM context_slices WHERE source_id=?1 AND range_type=?2 AND start_pos IS ?3 AND end_pos IS ?4 ORDER BY sort_order,id LIMIT 1",
            params![args.source_id, args.range_type, start_pos, end_pos],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let (id, sort_order) = if let Some(existing) = existing {
            tx.execute("UPDATE context_slices SET enabled=1,wrapper=?2,insert_at=?3 WHERE id=?1", params![existing.0, args.wrapper, args.insert_at])?;
            existing
        } else {
            let id = Uuid::new_v4().to_string();
            let order: i64 = tx.query_row("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM context_slices", [], |row| row.get(0))?;
            tx.execute(
                "INSERT INTO context_slices(id,source_id,range_type,start_pos,end_pos,enabled,sort_order,wrapper,insert_at) VALUES(?1,?2,?3,?4,?5,1,?6,?7,?8)",
                params![id, args.source_id, args.range_type, start_pos, end_pos, order, args.wrapper, args.insert_at],
            )?;
            (id, order)
        };
        tx.commit()?;
        Ok((id, sort_order))
    })?;
    Ok(ContextSlice {
        id,
        source_id: source.id,
        source_name: source.display_name,
        range_type: args.range_type,
        start_pos,
        end_pos,
        enabled: true,
        sort_order,
        wrapper: args.wrapper,
        insert_at: args.insert_at,
        estimated_tokens: estimate_tokens(&selected),
    })
}

pub fn update_slice(db: &Database, args: UpdateSliceArgs) -> AppResult<()> {
    let existing = list_slices(db)?
        .into_iter()
        .find(|slice| slice.id == args.slice_id)
        .ok_or_else(|| AppError::Message("context slice not found".into()))?;
    let enabled = args.enabled.unwrap_or(existing.enabled);
    let wrapper = args.wrapper.unwrap_or(existing.wrapper);
    let insert_at = args.insert_at.unwrap_or(existing.insert_at);
    let sort_order = args.sort_order.unwrap_or(existing.sort_order);
    if !matches!(wrapper.as_str(), "raw" | "labeled") {
        return Err(AppError::Message("invalid context wrapper".into()));
    }
    if !matches!(
        insert_at.as_str(),
        "before_current" | "inside_current" | "before_history" | "system"
    ) {
        return Err(AppError::Message("invalid context insertion point".into()));
    }
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE context_slices SET enabled=?2,wrapper=?3,insert_at=?4,sort_order=?5 WHERE id=?1",
            params![args.slice_id, enabled as i64, wrapper, insert_at, sort_order],
        )?;
        Ok(())
    })
}

pub fn delete_slice(db: &Database, slice_id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute("DELETE FROM context_slices WHERE id=?1", [slice_id])?;
        Ok(())
    })
}

pub fn gc_unreferenced_blobs(tx: &Transaction<'_>) -> AppResult<()> {
    tx.execute_batch(
        "DELETE FROM blobs
         WHERE NOT EXISTS (SELECT 1 FROM workspace_sources ws WHERE ws.blob_hash=blobs.hash)
           AND NOT EXISTS (SELECT 1 FROM request_context rc WHERE rc.blob_hash=blobs.hash);",
    )?;
    Ok(())
}

/// Require the complete current order so concurrent changes cannot silently disappear.
pub fn reorder_slices(db: &Database, conversation_id: &str, slice_ids: &[String]) -> AppResult<()> {
    db.with_conn_mut(|conn| {
        let tx = conn.transaction()?;
        let current = {
            let mut stmt = tx.prepare("SELECT cs.id FROM context_slices cs JOIN workspace_sources ws ON ws.id=cs.source_id WHERE ws.conversation_id=?1")?;
            let ids = stmt
                .query_map([conversation_id], |row| row.get::<_, String>(0))?
                .collect::<Result<HashSet<_>, _>>()?;
            ids
        };
        let requested: HashSet<_> = slice_ids.iter().cloned().collect();
        if requested != current || requested.len() != slice_ids.len() {
            return Err(AppError::Message(
                "Context changed; refresh and try reordering again".into(),
            ));
        }
        for (order, id) in slice_ids.iter().enumerate() {
            tx.execute(
                "UPDATE context_slices SET sort_order=?2 WHERE id=?1",
                params![id, order as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(source: &WorkspaceSource) -> AddSliceArgs {
        AddSliceArgs {
            source_id: source.id.clone(),
            range_type: "all".into(),
            start_pos: None,
            end_pos: None,
            wrapper: "raw".into(),
            insert_at: "inside_current".into(),
        }
    }

    #[test]
    fn invalid_ranges_do_not_persist_and_repeated_includes_update_in_place() {
        let db = Database::open(":memory:".into()).unwrap();
        let conversation = crate::db::chat::create_conversation(&db).unwrap();
        let source = add_source(
            &db,
            &conversation.id,
            "sample.txt".into(),
            "sample.txt".into(),
            None,
            "日本語\r\nsecond\n",
        )
        .unwrap();
        assert_eq!(
            add_source(
                &db,
                &conversation.id,
                "sample.txt".into(),
                "sample.txt".into(),
                None,
                "日本語\r\nsecond\n"
            )
            .unwrap()
            .id,
            source.id
        );
        for (start, end) in [(0, 1), (2, 1), (1, 4)] {
            let mut invalid = args(&source);
            invalid.range_type = "lines".into();
            invalid.start_pos = Some(start);
            invalid.end_pos = Some(end);
            assert!(add_slice(&db, invalid).is_err());
        }
        assert!(list_slices(&db).unwrap().is_empty());
        let slice = add_slice(&db, args(&source)).unwrap();
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE context_slices SET enabled=0 WHERE id=?1",
                [&slice.id],
            )?;
            Ok(())
        })
        .unwrap();
        let mut updated = args(&source);
        updated.wrapper = "labeled".into();
        let repeated = add_slice(&db, updated).unwrap();
        assert_eq!(slice.id, repeated.id);
        let slices = list_slices(&db).unwrap();
        assert_eq!(slices.len(), 1);
        assert!(slices[0].enabled);
        assert_eq!(slices[0].wrapper, "labeled");
        let last_line = source_lines(&db, &source.id, 3, 200).unwrap();
        assert_eq!(last_line.total_lines, 3);
        assert_eq!(last_line.lines, vec![""]);
    }

    #[test]
    fn reorder_is_atomic_and_rejects_stale_or_duplicate_orders() {
        let db = Database::open(":memory:".into()).unwrap();
        let conversation = crate::db::chat::create_conversation(&db).unwrap();
        let first =
            add_source(&db, &conversation.id, "a.txt".into(), "a".into(), None, "A").unwrap();
        let second =
            add_source(&db, &conversation.id, "b.txt".into(), "b".into(), None, "B").unwrap();
        let a = add_slice(&db, args(&first)).unwrap();
        let b = add_slice(&db, args(&second)).unwrap();
        reorder_slices(&db, &conversation.id, &[b.id.clone(), a.id.clone()]).unwrap();
        assert_eq!(list_slices(&db).unwrap()[0].id, b.id);
        assert!(reorder_slices(&db, &conversation.id, &[a.id.clone(), a.id.clone()]).is_err());
        assert!(reorder_slices(&db, &conversation.id, &[a.id]).is_err());
        let order = list_slices(&db).unwrap();
        assert_eq!(order[0].id, b.id);
        assert_eq!(order[0].sort_order, 0);
        assert_eq!(order[1].sort_order, 1);
    }

    #[test]
    fn chat_libraries_persist_and_explicit_references_survive_source_deletion() {
        let path = std::env::temp_dir().join(format!("cerachat-scope-{}.sqlite", Uuid::new_v4()));
        let db = Database::open(path.clone()).unwrap();
        let a = crate::db::chat::create_conversation(&db).unwrap();
        let b = crate::db::chat::create_conversation(&db).unwrap();
        let source = add_source(&db, &a.id, "a.txt".into(), "paste".into(), None, "AAA").unwrap();
        let attachment = add_slice(&db, args(&source)).unwrap();
        assert!(conversation_slices(&db, &b.id).unwrap().is_empty());
        let referenced = reference_source(&db, &b.id, &source.id).unwrap();
        assert_ne!(referenced.id, source.id);
        assert_eq!(referenced.blob_hash, source.blob_hash);
        assert_eq!(
            reference_source(&db, &b.id, &source.id).unwrap().id,
            referenced.id
        );
        assert_eq!(
            add_source(&db, &b.id, "a.txt".into(), "paste".into(), None, "AAA")
                .unwrap()
                .id,
            referenced.id
        );
        assert!(conversation_slices(&db, &b.id).unwrap().is_empty());
        let copied_attachment = add_slice(&db, args(&referenced)).unwrap();
        assert_ne!(attachment.id, copied_attachment.id);
        // Reordering one chat requires only its own attachments.
        reorder_slices(&db, &a.id, std::slice::from_ref(&attachment.id)).unwrap();
        assert!(reorder_slices(&db, &a.id, std::slice::from_ref(&copied_attachment.id)).is_err());
        drop(db);
        let db = Database::open(path.clone()).unwrap();
        assert_eq!(
            conversation_slices(&db, &a.id).unwrap()[0].id,
            attachment.id
        );
        assert_eq!(
            conversation_slices(&db, &b.id).unwrap()[0].id,
            copied_attachment.id
        );
        remove_source(&db, &source.id).unwrap();
        assert!(conversation_slices(&db, &a.id).unwrap().is_empty());
        assert_eq!(source_text(&db, &referenced.id).unwrap(), "AAA");
        let second = add_source(&db, &a.id, "b.txt".into(), "paste".into(), None, "BBB").unwrap();
        let second_reference = reference_source(&db, &b.id, &second.id).unwrap();
        crate::db::chat::delete_conversation(&db, &a.id).unwrap();
        assert_eq!(list_sources(&db).unwrap().len(), 2);
        assert_eq!(source_text(&db, &second_reference.id).unwrap(), "BBB");
        crate::db::chat::delete_conversation(&db, &b.id).unwrap();
        assert!(list_sources(&db).unwrap().is_empty());
        assert!(list_slices(&db).unwrap().is_empty());
        db.with_conn(|conn| {
            let count: i64 = conn.query_row("SELECT COUNT(*) FROM blobs", [], |row| row.get(0))?;
            assert_eq!(count, 0);
            Ok(())
        })
        .unwrap();
        drop(db);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn legacy_sources_remain_available_only_for_explicit_reuse() {
        let db = Database::open(":memory:".into()).unwrap();
        let chat = crate::db::chat::create_conversation(&db).unwrap();
        let legacy =
            add_source(&db, &chat.id, "old.txt".into(), "paste".into(), None, "OLD").unwrap();
        add_slice(&db, args(&legacy)).unwrap();
        db.with_conn(|conn| {
            conn.execute("UPDATE workspace_sources SET conversation_id=NULL", [])?;
            super::super::schema::migrate(conn)?;
            Ok(())
        })
        .unwrap();
        assert!(list_sources(&db).unwrap()[0].conversation_id.is_none());
        assert!(conversation_slices(&db, &chat.id).unwrap().is_empty());
        let restored = reference_source(&db, &chat.id, &legacy.id).unwrap();
        assert_eq!(source_text(&db, &restored.id).unwrap(), "OLD");
        assert_eq!(restored.conversation_id.as_deref(), Some(chat.id.as_str()));
    }
}
