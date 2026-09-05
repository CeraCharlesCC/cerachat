use rusqlite::params;

use crate::{error::AppResult, models::CompiledRequest};

use super::{now_ms, Database};

pub fn insert_request_log(
    db: &Database,
    request_id: &str,
    conversation_id: &str,
    user_message_id: &str,
    compiled: &CompiledRequest,
) -> AppResult<()> {
    db.with_conn_mut(|conn| {
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO request_logs(id,conversation_id,user_message_id,assistant_message_id,request_sha256,compiled_prompt,actual_request_json,created_at)
             VALUES(?1,?2,?3,NULL,?4,?5,?6,?7)",
            params![
                request_id,
                conversation_id,
                user_message_id,
                compiled.request_sha256,
                compiled.compiled_prompt,
                compiled.request_json,
                now_ms(),
            ],
        )?;
        for hash in &compiled.context_blob_hashes {
            tx.execute(
                "INSERT OR IGNORE INTO request_context(request_id,blob_hash) VALUES(?1,?2)",
                params![request_id, hash],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}

pub fn attach_assistant(db: &Database, request_id: &str, assistant_message_id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE request_logs SET assistant_message_id=?2 WHERE id=?1",
            params![request_id, assistant_message_id],
        )?;
        Ok(())
    })
}
