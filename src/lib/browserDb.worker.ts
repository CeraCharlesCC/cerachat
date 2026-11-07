/** Persistent browser database. All SQLite connections and Zstd buffers stay in this Worker. */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { init as initZstd, compress, decompress } from '@bokuweb/zstd-wasm'
import type { Database, SAHPoolUtil } from '@sqlite.org/sqlite-wasm'

const DB_NAME = '/cerachat.sqlite3'
const SCHEMA_VERSION = 1
const MAX_IMPORT_BYTES = 256 * 1024 * 1024
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

type SqlBind = (string | number | null | Uint8Array)[]
type Statement = { sql: string; bind?: SqlBind }
type WorkerRequest = { id: number; op: string; args?: Record<string, unknown> }

type SQLite = Awaited<ReturnType<typeof sqlite3InitModule>>
let sqlite3: SQLite
let pool: SAHPoolUtil
let db: Database
let releaseLock: (() => void) | undefined

// Request the lock before touching the VFS. Other tabs must not silently edit
// the same SAH pool; browsers without Web Locks fail closed.
async function acquireOriginLock() {
  if (!navigator.locks?.request) throw new Error('Web Locks are unavailable. Browser database access requires a supported browser.')
  await new Promise<void>((resolve, reject) => {
    void navigator.locks.request('cerachat-opfs-database', { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) { reject(new Error('CeraChat data is in use by another tab. Close the other tab, then reload this page.')); return }
      resolve()
      await new Promise<void>((release) => { releaseLock = release })
    }).catch(reject)
  })
}

const CREATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, parent_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')), content TEXT NOT NULL,
  include_next INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
  reasoning_json TEXT, images_json TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY(parent_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, data BLOB NOT NULL, original_size INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_sources (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, origin_path TEXT NOT NULL,
  archive_path TEXT, blob_hash TEXT NOT NULL, line_count INTEGER NOT NULL, created_at INTEGER NOT NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY(blob_hash) REFERENCES blobs(hash)
);
CREATE INDEX IF NOT EXISTS idx_workspace_sources_blob ON workspace_sources(blob_hash);
CREATE TABLE IF NOT EXISTS context_slices (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL,
  range_type TEXT NOT NULL CHECK (range_type IN ('all','lines','chars')),
  start_pos INTEGER, end_pos INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL, wrapper TEXT NOT NULL CHECK (wrapper IN ('raw','labeled')),
  insert_at TEXT NOT NULL CHECK (insert_at IN ('before_current','inside_current','before_history','system')),
  FOREIGN KEY(source_id) REFERENCES workspace_sources(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_context_slices_order ON context_slices(sort_order);
CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
  user_message_id TEXT, assistant_message_id TEXT,
  request_sha256 TEXT NOT NULL, compiled_prompt TEXT NOT NULL,
  actual_request_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY(user_message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY(assistant_message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS request_context (
  request_id TEXT NOT NULL, blob_hash TEXT NOT NULL,
  PRIMARY KEY(request_id, blob_hash),
  FOREIGN KEY(request_id) REFERENCES request_logs(id) ON DELETE CASCADE,
  FOREIGN KEY(blob_hash) REFERENCES blobs(hash)
);`

function rows(sql: string, bind: SqlBind = [], conn = db): Record<string, unknown>[] {
  return conn.exec({ sql, bind, rowMode: 'object', returnValue: 'resultRows' }) as Record<string, unknown>[]
}
function run(statement: Statement, conn = db) {
  conn.exec({ sql: statement.sql, bind: statement.bind ?? [] })
}
function hasColumn(conn: Database, table: string, column: string) {
  return rows(`PRAGMA table_info(${table})`, [], conn).some((row) => row.name === column)
}
function version(conn: Database): number {
  return Number(rows('PRAGMA user_version', [], conn)[0]?.user_version ?? 0)
}
function verifySchema(conn: Database) {
  const v = version(conn)
  if (v > SCHEMA_VERSION) throw new Error(`Database schema ${v} is newer than this CeraChat version (${SCHEMA_VERSION}); upgrade the app before opening it.`)
  const integrity = rows('PRAGMA integrity_check', [], conn)[0]
  if (!integrity || integrity.integrity_check !== 'ok') throw new Error('SQLite integrity check failed')
  if (rows('PRAGMA foreign_key_check', [], conn).length) throw new Error('Database contains invalid references')
  for (const table of ['conversations', 'messages', 'blobs', 'workspace_sources', 'context_slices', 'request_logs', 'request_context']) {
    if (!rows("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table], conn).length) {
      throw new Error(`Database is missing the ${table} table`)
    }
  }
}
function migrate(conn: Database) {
  if (version(conn) > SCHEMA_VERSION) throw new Error(`Unsupported future database version ${version(conn)}`)
  conn.exec('BEGIN IMMEDIATE')
  try {
    // Legacy desktop databases may have the core tables without the newer columns.
    // Create core tables first, then apply the same additive migrations as Rust.
    conn.exec(CREATE_SCHEMA)
    if (!hasColumn(conn, 'workspace_sources', 'conversation_id')) conn.exec('ALTER TABLE workspace_sources ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE')
    if (!hasColumn(conn, 'messages', 'reasoning_json')) conn.exec('ALTER TABLE messages ADD COLUMN reasoning_json TEXT')
    if (!hasColumn(conn, 'messages', 'images_json')) conn.exec("ALTER TABLE messages ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]'")
    conn.exec('CREATE INDEX IF NOT EXISTS idx_workspace_sources_conversation ON workspace_sources(conversation_id)')
    // Browser-only request state is additive; desktop INSERT statements remain compatible.
    if (!hasColumn(conn, 'request_logs', 'browser_status')) conn.exec("ALTER TABLE request_logs ADD COLUMN browser_status TEXT NOT NULL DEFAULT 'completed'")
    conn.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    conn.exec('COMMIT')
  } catch (e) { conn.exec('ROLLBACK'); throw e }
}

async function start() {
  await acquireOriginLock()
  if (!navigator.storage?.getDirectory) throw new Error('OPFS is unavailable. Data will not be written to temporary memory.')
  try {
    sqlite3 = await sqlite3InitModule()
    pool = await sqlite3.installOpfsSAHPoolVfs({ initialCapacity: 6, name: 'cerachat-sahpool' })
    db = new pool.OpfsSAHPoolDb(DB_NAME)
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE;')
    migrate(db)
    // A crashed, closed, or reloaded tab cannot be running its former request.
    // Preserve its immutable audit and mark it interrupted; never auto-retry.
    db.exec("UPDATE request_logs SET browser_status='interrupted' WHERE browser_status='pending'")
    await initZstd()
    if (import.meta.env.VITE_CERACHAT_TEST_FIXTURES === 'true') await seedTestFixtures()
  } catch (error) {
    releaseLock?.()
    throw new Error(`Persistent browser storage could not start: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The demo does not ship as browser user data. The Playwright server alone
 * opts in to deterministic records so that preexisting UI scenarios can run. */
async function seedTestFixtures() {
  if (rows('SELECT COUNT(*) AS total FROM conversations')[0]?.total) return
  const { demoBootstrap, demoMessages, demoSourceLines } = await import('./demo')
  const statements: Statement[] = []
  for (const row of demoBootstrap.conversations) {
    statements.push({ sql: 'INSERT INTO conversations(id,title,created_at,updated_at) VALUES(?,?,?,?)',
      bind: [row.id, row.title, row.created_at, row.updated_at] })
  }
  for (const message of demoMessages) {
    statements.push({ sql: `INSERT INTO messages(id,conversation_id,parent_id,role,content,include_next,created_at,reasoning_json,images_json)
      VALUES(?,?,?,?,?,?,?,?,?)`, bind: [message.id, message.conversation_id, message.parent_id,
      message.role, message.content, Number(message.include_next), message.created_at,
      message.reasoning ? JSON.stringify(message.reasoning) : null, JSON.stringify(message.images ?? [])] })
  }
  for (const source of demoBootstrap.sources) {
    const content = demoSourceLines(source.id, 1, source.line_count).lines.join('\n')
    const raw = textEncoder.encode(content)
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map((v) => v.toString(16).padStart(2, '0')).join('')
    statements.push({ sql: 'INSERT OR IGNORE INTO blobs(hash,data,original_size) VALUES(?,?,?)',
      bind: [hash, compress(raw, 3), raw.length] })
    statements.push({ sql: `INSERT INTO workspace_sources(id,conversation_id,display_name,origin_path,archive_path,blob_hash,line_count,created_at)
      VALUES(?,?,?,?,?,?,?,?)`, bind: [source.id, source.conversation_id, source.display_name,
      source.origin_path, source.archive_path, hash, source.line_count, source.created_at] })
  }
  for (const slice of demoBootstrap.slices) {
    statements.push({ sql: `INSERT INTO context_slices(id,source_id,range_type,start_pos,end_pos,enabled,sort_order,wrapper,insert_at)
      VALUES(?,?,?,?,?,?,?,?,?)`, bind: [slice.id, slice.source_id, slice.range_type, slice.start_pos,
      slice.end_pos, Number(slice.enabled), slice.sort_order, slice.wrapper, slice.insert_at] })
  }
  inTransaction(statements)
}

function inTransaction(statements: Statement[]) {
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const statement of statements) run(statement)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
async function addSource(args: Record<string, unknown>) {
  const id = args.id as string
  const conversationId = args.conversationId as string
  const name = args.name as string
  const sourceText = args.text as string
  const raw = textEncoder.encode(sourceText)
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', raw))
  const hash = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
  const existing = rows(`SELECT w.*,b.original_size FROM workspace_sources w JOIN blobs b ON b.hash=w.blob_hash WHERE w.conversation_id=? AND w.display_name=?
    AND w.origin_path='pasted-text' AND w.blob_hash=?`, [conversationId, name, hash])[0]
  if (existing) return existing
  const blob = compress(raw, 3)
  const now = Date.now()
  inTransaction([
    { sql: 'INSERT OR IGNORE INTO blobs(hash,data,original_size) VALUES(?,?,?)', bind: [hash, blob, raw.length] },
    { sql: `INSERT INTO workspace_sources(id,conversation_id,display_name,origin_path,archive_path,blob_hash,line_count,created_at)
      VALUES(?,?,?,'pasted-text',NULL,?,?,?)`, bind: [id, conversationId, name, hash, sourceText.split('\n').length, now] },
  ])
  return rows(`SELECT w.*,b.original_size FROM workspace_sources w JOIN blobs b ON b.hash=w.blob_hash WHERE w.id=?`, [id])[0]
}
function readSource(sourceId: string): string {
  const row = rows(`SELECT b.data,b.original_size FROM workspace_sources w JOIN blobs b ON b.hash=w.blob_hash WHERE w.id=?`, [sourceId])[0]
  if (!row) throw new Error('Source not found')
  const decompressed = decompress(row.data as Uint8Array)
  if (decompressed.length !== row.original_size) throw new Error('Source length does not match stored blob')
  return textDecoder.decode(decompressed)
}
function validateSnapshot(snapshot: Uint8Array) {
  if (snapshot.length < 512 || snapshot.length > MAX_IMPORT_BYTES) throw new Error('Backup database size is outside the supported limit')
  const tmpName = '/cerachat-import-validation.sqlite3'
  // Verify a separate file before touching the live database. SQLite's VFS
  // import implementation validates the file header and disables WAL mode.
  return (async () => {
    await pool.reserveMinimumCapacity(8)
    pool.unlink(tmpName)
    try {
      await pool.importDb(tmpName, snapshot)
      const tempDb = new pool.OpfsSAHPoolDb(tmpName)
      try {
        tempDb.exec('PRAGMA foreign_keys=ON')
        verifySchema(tempDb)
      } finally { tempDb.close() }
    } finally { pool.unlink(tmpName) }
  })()
}
async function importSnapshot(snapshot: Uint8Array) {
  await validateSnapshot(snapshot)
  const old = sqlite3.capi.sqlite3_js_db_export(db.pointer!)
  db.close()
  try {
    await pool.importDb(DB_NAME, snapshot)
    db = new pool.OpfsSAHPoolDb(DB_NAME)
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE;')
    migrate(db)
    verifySchema(db)
  } catch (error) {
    db?.close()
    await pool.importDb(DB_NAME, old)
    db = new pool.OpfsSAHPoolDb(DB_NAME)
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE;')
    throw new Error(`Backup import failed; the original database was restored. ${error instanceof Error ? error.message : String(error)}`)
  }
}

const init = start()
let queue = Promise.resolve()
const scope = self as unknown as {
  postMessage: (message: unknown) => void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
}
scope.onmessage = ({ data: message }) => {
  queue = queue.then(async () => {
    try {
      await init
      const args = message.args ?? {}
      let result: unknown
      switch (message.op) {
        case 'query': result = rows(args.sql as string, args.bind as SqlBind | undefined); break
        case 'execute': run({ sql: args.sql as string, bind: args.bind as SqlBind | undefined }); break
        case 'batch': inTransaction(args.statements as Statement[]); break
        case 'addSource': result = await addSource(args); break
        case 'sourceText': result = readSource(args.sourceId as string); break
        case 'export': result = sqlite3.capi.sqlite3_js_db_export(db.pointer!); break
        case 'import': await importSnapshot(args.bytes as Uint8Array); break
        case 'health': result = { version: version(db), vfs: pool.vfsName }; break
        default: throw new Error(`Unknown browser storage operation: ${message.op}`)
      }
      scope.postMessage({ id: message.id, ok: true, result })
    } catch (error) {
      scope.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }).catch((error) => { scope.postMessage({ id: message.id, ok: false, error: String(error) }) })
}
