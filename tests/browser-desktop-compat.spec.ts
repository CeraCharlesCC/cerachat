import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const desktopFixture = readFile(new URL('./fixtures/desktop-current.sqlite3', import.meta.url))
const legacyFixture = readFile(new URL('./fixtures/desktop-legacy.sqlite3', import.meta.url))

test('imports desktop Rust SQLite schema, Zstandard blobs, branches, reasoning and audits', async ({ page }) => {
  const fixture = [...await desktopFixture]
  await page.goto('/')
  const restored = await page.evaluate(async (bytes) => {
    const backend = await import('/src/lib/backend.ts')
    const storage = await import('/src/lib/browserStorage.ts')
    await storage.importSnapshot(Uint8Array.from(bytes))
    const data = await backend.bootstrap()
    const messages = await backend.getMessages('desktop-chat')
    const source = await backend.getSourceLines('desktop-source')
    const logs = await storage.query<{ actual_request_json: string; browser_status: string }>(
      'SELECT actual_request_json,browser_status FROM request_logs WHERE id=?', ['desktop-request'])
    return { data, messages, source, logs, version: (await storage.storageReady()).version }
  }, fixture)
  expect(restored.data.conversations.map((row) => row.id)).toEqual(['desktop-chat'])
  expect(restored.data.sources[0].original_size).toBe(new TextEncoder().encode('Hello from Rust SQLite!\n日本語の行\nZstandard\n').length)
  expect(restored.data.slices[0].source_name).toBe('desktop.txt')
  expect(restored.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  expect(restored.messages[1].reasoning?.parts[0].text).toBe('Desktop reasoning summary')
  expect(restored.source.lines).toEqual(['Hello from Rust SQLite!', '日本語の行', 'Zstandard', ''])
  expect(restored.logs).toEqual([{ actual_request_json: '{"model":"desktop"}', browser_status: 'completed' }])
  expect(restored.version).toBe(1)
  await page.reload()
  const after = await page.evaluate(async () => {
    const backend = await import('/src/lib/backend.ts')
    return backend.getMessages('desktop-chat')
  })
  expect(after.map((message) => message.id)).toEqual(['desktop-user', 'desktop-answer'])
})

test('upgrades legacy desktop source ownership and message columns without data loss', async ({ page }) => {
  const fixture = [...await legacyFixture]
  await page.goto('/')
  const migrated = await page.evaluate(async (bytes) => {
    const backend = await import('/src/lib/backend.ts')
    const storage = await import('/src/lib/browserStorage.ts')
    await storage.importSnapshot(Uint8Array.from(bytes))
    return {
      state: await backend.bootstrap(),
      messages: await backend.getMessages('legacy-chat'),
      lines: await backend.getSourceLines('legacy-source'),
      cols: await storage.query<{ name: string }>('PRAGMA table_info(messages)'),
      health: await storage.storageReady(),
    }
  }, fixture)
  expect(migrated.state.sources[0].conversation_id).toBeNull()
  expect(migrated.messages[0].content).toBe('Old Rust record')
  expect(migrated.messages[0].images).toEqual([])
  expect(migrated.lines.lines).toEqual(['Legacy global library source', 'Zstd payload', ''])
  expect(migrated.cols.map((column) => column.name)).toEqual(expect.arrayContaining(['reasoning_json', 'images_json']))
  expect(migrated.health.version).toBe(1)
})

test('refuses a database created by a newer app without replacing local data', async ({ page }) => {
  const fixture = [...await desktopFixture]
  await page.goto('/')
  const result = await page.evaluate(async (bytes) => {
    const backend = await import('/src/lib/backend.ts')
    const storage = await import('/src/lib/browserStorage.ts')
    const original = await backend.createConversation()
    // SQLite's user_version is the big-endian u32 at header offset 60.
    const future = Uint8Array.from(bytes)
    new DataView(future.buffer).setUint32(60, 999, false)
    let error = ''
    try { await storage.importSnapshot(future) }
    catch (reason) { error = String(reason) }
    const after = await backend.bootstrap()
    return { original: original.id, ids: after.conversations.map((row) => row.id), error }
  }, fixture)
  expect(result.error).toMatch(/newer than this CeraChat version/i)
  expect(result.ids).toContain(result.original)
  expect(result.ids).not.toContain('desktop-chat')
})
