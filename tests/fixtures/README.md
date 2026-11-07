# Rust SQLite interoperability fixtures

`desktop-current.sqlite3` is a 0-version SQLite database using the exact DDL
from `src-tauri/src/db/schema.rs` plus its three current additive columns
(`workspace_sources.conversation_id`, `messages.reasoning_json`, and
`messages.images_json`). It contains a conversation, branched message ancestry,
reasoning, a Zstandard-compressed UTF-8 source, a context slice, and a request
log with a blob reference.

`desktop-legacy.sqlite3` uses the same core DDL but intentionally omits those
three additive columns. It contains a legacy global source with no conversation
owner, as covered by the Rust desktop's migration tests.

Both fixtures were generated with Python's `sqlite3` module using the schema
above and `zstd -3` for compressed source blobs. Both passed
`PRAGMA integrity_check` and `PRAGMA foreign_key_check` before being committed.
They deliberately contain no provider API keys or private user data.
