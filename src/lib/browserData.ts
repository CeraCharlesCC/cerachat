/** Transactional domain operations for the browser SQLite backend.
 * The worker owns the database; React never reads browser storage directly.
 */
import type { AddSliceArgs, BootstrapState, ContextSlice, Conversation, Message, Reasoning, RequestPreview, SourceLines, UpdateSliceArgs, WorkspaceSource } from '../types'
import { editedReasoning } from './reasoning'
import { estimateTokens } from './utils'
import { addSource, execute, getSourceText, query, storageReady, transaction, type Statement } from './browserStorage'

interface DbMessage {
  id: string; conversation_id: string; parent_id: string | null; role: Message['role']; content: string;
  include_next: number; created_at: number; reasoning_json: string | null; images_json: string
}
interface DbSlice {
  id: string; source_id: string; source_name: string; range_type: ContextSlice['range_type'];
  start_pos: number | null; end_pos: number | null; enabled: number; sort_order: number;
  wrapper: ContextSlice['wrapper']; insert_at: ContextSlice['insert_at'];
}
const MSG_FIELDS = 'id,conversation_id,parent_id,role,content,include_next,created_at,reasoning_json,images_json'
const SLICE_FIELDS = `s.id,s.source_id,w.display_name AS source_name,s.range_type,s.start_pos,s.end_pos,
  s.enabled,s.sort_order,s.wrapper,s.insert_at`
const SOURCE_FIELDS = `w.id,w.conversation_id,w.display_name,w.origin_path,w.archive_path,w.blob_hash,
  b.original_size,w.line_count,w.created_at`

const msg = (row: DbMessage): Message => ({
  id: row.id, conversation_id: row.conversation_id, parent_id: row.parent_id, role: row.role,
  content: row.content, include_next: !!row.include_next, created_at: row.created_at,
  ...(row.reasoning_json ? { reasoning: JSON.parse(row.reasoning_json) as Reasoning } : {}),
  images: JSON.parse(row.images_json || '[]') as Message['images'],
})
const sqlMessage = (message: Message): Statement => ({
  sql: `INSERT INTO messages(${MSG_FIELDS}) VALUES(?,?,?,?,?,?,?,?,?)`,
  bind: [message.id, message.conversation_id, message.parent_id, message.role, message.content,
    Number(message.include_next), message.created_at, message.reasoning ? JSON.stringify(message.reasoning) : null,
    JSON.stringify(message.images ?? [])],
})
const sliceRow = (row: DbSlice, tokens = 0): ContextSlice => ({
  id: row.id, source_id: row.source_id, source_name: row.source_name,
  range_type: row.range_type, start_pos: row.start_pos, end_pos: row.end_pos,
  enabled: !!row.enabled, sort_order: row.sort_order, wrapper: row.wrapper,
  insert_at: row.insert_at, estimated_tokens: tokens,
})

export async function bootstrap(): Promise<Omit<BootstrapState, 'provider_catalog'>> {
  await storageReady()
  const [conversations, sources, slices] = await Promise.all([
    query<Conversation>('SELECT id,title,created_at,updated_at FROM conversations ORDER BY updated_at DESC,id'),
    query<WorkspaceSource>(`SELECT ${SOURCE_FIELDS} FROM workspace_sources w JOIN blobs b ON b.hash=w.blob_hash ORDER BY w.created_at DESC,w.id`),
    getSlices(),
  ])
  return { conversations, sources, slices }
}
export async function getMessages(conversationId: string): Promise<Message[]> {
  const data = await query<DbMessage>(`SELECT ${MSG_FIELDS} FROM messages WHERE conversation_id=? ORDER BY created_at,id`, [conversationId])
  return data.map(msg)
}
export async function getMessage(messageId: string): Promise<Message | undefined> {
  const data = await query<DbMessage>(`SELECT ${MSG_FIELDS} FROM messages WHERE id=?`, [messageId])
  return data[0] ? msg(data[0]) : undefined
}
export async function getConversation(conversationId: string): Promise<Conversation> {
  const rows = await query<Conversation>('SELECT * FROM conversations WHERE id=?', [conversationId])
  if (!rows[0]) throw new Error('Conversation not found')
  return rows[0]
}
export async function createConversation(): Promise<Conversation> {
  const now = Date.now()
  const conversation = { id: crypto.randomUUID(), title: 'New chat', created_at: now, updated_at: now }
  await execute('INSERT INTO conversations(id,title,created_at,updated_at) VALUES(?,?,?,?)',
    [conversation.id, conversation.title, conversation.created_at, conversation.updated_at])
  return conversation
}
export async function deleteConversation(conversationId: string) {
  await transaction([
    { sql: 'DELETE FROM conversations WHERE id=?', bind: [conversationId] },
    { sql: `DELETE FROM blobs WHERE NOT EXISTS (SELECT 1 FROM workspace_sources WHERE blob_hash=blobs.hash)
      AND NOT EXISTS (SELECT 1 FROM request_context WHERE blob_hash=blobs.hash)` },
  ])
}
export async function setMessageIncluded(messageId: string, included: boolean) {
  await execute('UPDATE messages SET include_next=? WHERE id=?', [Number(included), messageId])
}
export async function setReasoningPartIncluded(messageId: string, partId: string, included: boolean) {
  const message = await getMessage(messageId)
  if (message?.role !== 'assistant') throw new Error('Reasoning block not found')
  const part = message.reasoning?.parts.find((entry) => entry.id === partId)
  if (!part) throw new Error('Reasoning block not found')
  if (included && !part.text) throw new Error('Reasoning block has no visible text')
  part.include_next = included
  await execute('UPDATE messages SET reasoning_json=? WHERE id=?', [JSON.stringify(message.reasoning), messageId])
}
export async function deleteBranch(messageId: string) {
  await execute(`WITH RECURSIVE descendants(id) AS (
    SELECT id FROM messages WHERE id=? UNION ALL
    SELECT m.id FROM messages m JOIN descendants d ON m.parent_id=d.id
  ) DELETE FROM messages WHERE id IN (SELECT id FROM descendants)`, [messageId])
}
export async function editMessage(messageId: string, content: string, reasoning?: Reasoning | null): Promise<Message> {
  const original = await getMessage(messageId)
  if (!original) throw new Error('Message not found')
  const nextReasoning = reasoning === undefined ? (original.content === content ? original.reasoning ?? null : null) : editedReasoning(original.reasoning, reasoning)
  if (original.role !== 'assistant' && nextReasoning) throw new Error('Reasoning requires an assistant message')
  if (!content.trim() && !original.images?.length && !nextReasoning?.parts.some((part) => part.text.trim())) throw new Error('Message content cannot be empty')
  if (original.content === content && JSON.stringify(nextReasoning) === JSON.stringify(original.reasoning ?? null)) return original
  const edited = { ...original, id: crypto.randomUUID(), content, reasoning: nextReasoning, created_at: Date.now() }
  await transaction([sqlMessage(edited), { sql: 'UPDATE conversations SET updated_at=? WHERE id=?', bind: [edited.created_at, edited.conversation_id] }])
  return edited
}
export async function addTextSource(conversationId: string, name: string, text: string) {
  await getConversation(conversationId)
  if (!name.trim() || !text.trim()) throw new Error('A name and text are required')
  if (new TextEncoder().encode(text).length > 16 * 1024 * 1024) throw new Error('Pasted source exceeds the browser limit of 16 MiB')
  return addSource(crypto.randomUUID(), conversationId, name.trim(), text)
}
export async function sourceText(sourceId: string) { return getSourceText(sourceId) }
export function sliceText(text: string, args: AddSliceArgs): string {
  if (args.rangeType === 'all') return text
  const units = args.rangeType === 'lines' ? text.split('\n') : Array.from(text)
  const offset = args.rangeType === 'lines' ? 1 : 0
  const start = args.startPos ?? offset
  const end = args.endPos ?? (args.rangeType === 'lines' ? start : units.length)
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < offset || end < start || end > units.length || (offset === 1 && !text)) throw new Error('Range is outside the source')
  return units.slice(start - offset, end).join(offset ? '\n' : '') + (offset && end < units.length ? '\n' : '')
}
export async function getSlices(conversationId?: string): Promise<ContextSlice[]> {
  const data = await query<DbSlice>(`SELECT ${SLICE_FIELDS} FROM context_slices s
    JOIN workspace_sources w ON w.id=s.source_id ${conversationId ? 'WHERE w.conversation_id=?' : ''}
    ORDER BY s.sort_order,s.id`, conversationId ? [conversationId] : [])
  const tokens = new Map<string, string>()
  const result: ContextSlice[] = []
  for (const row of data) {
    let text = tokens.get(row.source_id)
    if (text === undefined) { text = await sourceText(row.source_id); tokens.set(row.source_id, text) }
    result.push(sliceRow(row, estimateTokens(sliceText(text, { sourceId: row.source_id,
      rangeType: row.range_type, startPos: row.start_pos, endPos: row.end_pos,
      wrapper: row.wrapper, insertAt: row.insert_at }))))
  }
  return result
}
export async function reorderContextSlices(conversationId: string, sliceIds: string[]) {
  await getConversation(conversationId)
  const slices = await getSlices(conversationId)
  const ids = new Set(sliceIds)
  if (ids.size !== sliceIds.length || ids.size !== slices.length || slices.some((slice) => !ids.has(slice.id))) throw new Error('Context changed; refresh and try reordering again')
  await transaction(sliceIds.map((id, index) => ({ sql: 'UPDATE context_slices SET sort_order=? WHERE id=?', bind: [index, id] })))
}
export async function referenceSource(conversationId: string, sourceId: string) {
  await getConversation(conversationId)
  const sources = await query<WorkspaceSource>(`SELECT ${SOURCE_FIELDS} FROM workspace_sources w JOIN blobs b ON b.hash=w.blob_hash WHERE w.id=?`, [sourceId])
  const original = sources[0]
  if (!original) throw new Error('Source not found')
  const duplicates = await query<WorkspaceSource>(`SELECT ${SOURCE_FIELDS} FROM workspace_sources w JOIN blobs b ON b.hash=w.blob_hash
    WHERE w.conversation_id=? AND w.display_name=? AND w.origin_path=? AND w.archive_path IS ? AND w.blob_hash=?`,
  [conversationId, original.display_name, original.origin_path, original.archive_path, original.blob_hash])
  if (duplicates[0]) return duplicates[0]
  const referenced = { ...original, id: crypto.randomUUID(), conversation_id: conversationId, created_at: Date.now() }
  await execute(`INSERT INTO workspace_sources(id,conversation_id,display_name,origin_path,archive_path,blob_hash,line_count,created_at)
    VALUES(?,?,?,?,?,?,?,?)`, [referenced.id, conversationId, referenced.display_name, referenced.origin_path,
      referenced.archive_path, referenced.blob_hash, referenced.line_count, referenced.created_at])
  return referenced
}
export async function removeSource(sourceId: string) {
  await transaction([
    { sql: 'DELETE FROM workspace_sources WHERE id=?', bind: [sourceId] },
    { sql: `DELETE FROM blobs WHERE NOT EXISTS (SELECT 1 FROM workspace_sources WHERE blob_hash=blobs.hash)
      AND NOT EXISTS (SELECT 1 FROM request_context WHERE blob_hash=blobs.hash)` },
  ])
}
export async function getSourceLines(sourceId: string, startLine = 1, count = 200): Promise<SourceLines> {
  const text = await sourceText(sourceId)
  const lines = text ? text.split('\n') : []
  const start = Math.max(1, startLine)
  return { source_id: sourceId, start_line: start, total_lines: lines.length,
    lines: lines.slice(start - 1, start - 1 + Math.min(500, Math.max(0, count))) }
}
export async function addContextSlice(args: AddSliceArgs): Promise<ContextSlice> {
  const source = (await query<WorkspaceSource>(`SELECT ${SOURCE_FIELDS} FROM workspace_sources w JOIN blobs b ON b.hash=w.blob_hash WHERE w.id=?`, [args.sourceId]))[0]
  if (!source) throw new Error('Source not found')
  const selected = sliceText(await sourceText(source.id), args)
  const start = args.rangeType === 'all' ? null : args.startPos ?? null
  const end = args.rangeType === 'all' ? null : args.endPos ?? null
  const existing = (await query<DbSlice>(`SELECT ${SLICE_FIELDS} FROM context_slices s JOIN workspace_sources w ON w.id=s.source_id
    WHERE s.source_id=? AND s.range_type=? AND s.start_pos IS ? AND s.end_pos IS ?`,
  [args.sourceId, args.rangeType, start, end]))[0]
  if (existing) {
    await execute('UPDATE context_slices SET enabled=1,wrapper=?,insert_at=? WHERE id=?', [args.wrapper, args.insertAt, existing.id])
    return sliceRow({ ...existing, enabled: 1, wrapper: args.wrapper, insert_at: args.insertAt }, estimateTokens(selected))
  }
  const order = await query<{ max_order: number }>('SELECT COALESCE(MAX(sort_order),-1)+1 AS max_order FROM context_slices')
  const slice: ContextSlice = {
    id: crypto.randomUUID(), source_id: args.sourceId, source_name: source.display_name, range_type: args.rangeType,
    start_pos: start, end_pos: end, enabled: true, sort_order: order[0].max_order,
    wrapper: args.wrapper, insert_at: args.insertAt, estimated_tokens: estimateTokens(selected),
  }
  await execute(`INSERT INTO context_slices(id,source_id,range_type,start_pos,end_pos,enabled,sort_order,wrapper,insert_at)
    VALUES(?,?,?,?,?,1,?,?,?)`, [slice.id, slice.source_id, slice.range_type, start, end, slice.sort_order, slice.wrapper, slice.insert_at])
  return slice
}
export async function updateContextSlice(args: UpdateSliceArgs) {
  const fields: string[] = []
  const bind: (string | number | null)[] = []
  if (args.enabled !== undefined) { fields.push('enabled=?'); bind.push(Number(args.enabled)) }
  if (args.wrapper !== undefined) { fields.push('wrapper=?'); bind.push(args.wrapper) }
  if (args.insertAt !== undefined) { fields.push('insert_at=?'); bind.push(args.insertAt) }
  if (args.sortOrder !== undefined) { fields.push('sort_order=?'); bind.push(args.sortOrder) }
  if (fields.length) await execute(`UPDATE context_slices SET ${fields.join(',')} WHERE id=?`, [...bind, args.sliceId])
}
export async function deleteContextSlice(sliceId: string) {
  await execute('DELETE FROM context_slices WHERE id=?', [sliceId])
}

/** A single transaction persists the outgoing request, new user branch and
 * source references before the network request can start. */
export async function beginRequest(args: { requestId: string; conversationId: string; user: Message; preview: RequestPreview; existingUser: boolean }) {
  const slices = await query<{ blob_hash: string }>(`SELECT DISTINCT w.blob_hash FROM context_slices s
    JOIN workspace_sources w ON w.id=s.source_id WHERE w.conversation_id=? AND s.enabled=1`, [args.conversationId])
  const statements: Statement[] = [
    ...(!args.existingUser ? [sqlMessage(args.user)] : []),
    { sql: `INSERT INTO request_logs(id,conversation_id,user_message_id,assistant_message_id,request_sha256,compiled_prompt,actual_request_json,created_at,browser_status)
      VALUES(?,?,?,NULL,?,?,?,?, 'pending')`,
    bind: [args.requestId, args.conversationId, args.user.id, args.preview.request_sha256,
      args.preview.compiled_prompt, args.preview.request_json, Date.now()] },
    ...slices.map((row) => ({ sql: 'INSERT OR IGNORE INTO request_context(request_id,blob_hash) VALUES(?,?)', bind: [args.requestId, row.blob_hash] })),
    { sql: 'UPDATE conversations SET updated_at=? WHERE id=?', bind: [Date.now(), args.conversationId] },
  ]
  await transaction(statements)
}
export async function finishRequest(requestId: string, status: 'completed' | 'cancelled' | 'failed', assistant?: Message) {
  await transaction([
    ...(assistant ? [sqlMessage(assistant)] : []),
    { sql: 'UPDATE request_logs SET browser_status=?,assistant_message_id=? WHERE id=?', bind: [status, assistant?.id ?? null, requestId] },
  ])
}
