use std::io::Cursor;

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
    display_name: String,
    origin_path: String,
    archive_path: Option<String>,
    text: &str,
) -> AppResult<WorkspaceSource> {
    let bytes = text.as_bytes();
    let hash = hex::encode(Sha256::digest(bytes));
    let compressed = zstd::stream::encode_all(Cursor::new(bytes), 3)?;
    let source = WorkspaceSource {
        id: Uuid::new_v4().to_string(),
        display_name,
        origin_path,
        archive_path,
        blob_hash: hash.clone(),
        original_size: bytes.len() as i64,
        line_count: line_count(text),
        created_at: now_ms(),
    };

    db.with_conn(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO blobs(hash,data,original_size) VALUES(?1,?2,?3)",
            params![hash, compressed, bytes.len() as i64],
        )?;
        conn.execute(
            "INSERT INTO workspace_sources(id,display_name,origin_path,archive_path,blob_hash,line_count,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                source.id,
                source.display_name,
                source.origin_path,
                source.archive_path,
                source.blob_hash,
                source.line_count,
                source.created_at,
            ],
        )?;
        Ok(())
    })?;
    Ok(source)
}

pub fn list_sources(db: &Database) -> AppResult<Vec<WorkspaceSource>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT ws.id,ws.display_name,ws.origin_path,ws.archive_path,ws.blob_hash,b.original_size,ws.line_count,ws.created_at
             FROM workspace_sources ws JOIN blobs b ON b.hash=ws.blob_hash
             ORDER BY ws.created_at ASC",
        )?;
        Ok(stmt.query_map([], row_source)?.collect::<Result<Vec<_>, _>>()?)
    })
}

pub fn get_source(db: &Database, source_id: &str) -> AppResult<Option<WorkspaceSource>> {
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT ws.id,ws.display_name,ws.origin_path,ws.archive_path,ws.blob_hash,b.original_size,ws.line_count,ws.created_at
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
    let lines = text
        .lines()
        .skip(start - 1)
        .take(count)
        .map(str::to_string)
        .collect();
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
    let rows: Vec<(ContextSlice, String)> = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT cs.id,cs.source_id,ws.display_name,cs.range_type,cs.start_pos,cs.end_pos,cs.enabled,cs.sort_order,cs.wrapper,cs.insert_at,ws.blob_hash
             FROM context_slices cs JOIN workspace_sources ws ON ws.id=cs.source_id ORDER BY cs.sort_order ASC, cs.id ASC",
        )?;
        Ok(stmt.query_map([], row_slice_base)?.collect::<Result<Vec<_>, _>>()?)
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
    let id = Uuid::new_v4().to_string();
    let sort_order = db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM context_slices",
            [],
            |row| row.get(0),
        )?)
    })?;
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO context_slices(id,source_id,range_type,start_pos,end_pos,enabled,sort_order,wrapper,insert_at) VALUES(?1,?2,?3,?4,?5,1,?6,?7,?8)",
            params![id, args.source_id, args.range_type, args.start_pos, args.end_pos, sort_order, args.wrapper, args.insert_at],
        )?;
        Ok(())
    })?;
    let text = source_text(db, &source.id)?;
    let selected = slice_text(&text, &args.range_type, args.start_pos, args.end_pos)?;
    Ok(ContextSlice {
        id,
        source_id: source.id,
        source_name: source.display_name,
        range_type: args.range_type,
        start_pos: args.start_pos,
        end_pos: args.end_pos,
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
