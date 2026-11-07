import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const provider = {
  id: 'backuptest', name: 'Backup test provider', protocol: 'openai_chat_completions' as const,
  base_url: 'https://backup.invalid/v1', api_key_storage: 'plain_portable' as const,
  system_text: '', context_separator: '\n\n',
}
const model = {
  provider_id: 'backuptest', model_id: 'test', name: 'Test model', context_window: 1024,
  max_output_tokens: 128, temperature: null, raw_json_overrides: '{}',
}

test('versioned local backup validates checksums, database header, settings and zip boundaries', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async ({ provider, model }) => {
    const { packBrowserBackup, inspectBrowserBackup, settingsAdditions } = await import('/src/lib/browserBackup.ts')
    const catalog = { providers: [provider], models: [model], selected_model_id: 'backuptest::test' as const }
    const db = new Uint8Array(4096)
    db.set(new TextEncoder().encode('SQLite format 3\0'))
    const zipped = await packBrowserBackup(db, catalog)
    const read = await inspectBrowserBackup(zipped)

    const altered = zipped.slice()
    const header = new TextEncoder().encode('SQLite format 3\0')
    let location = -1
    for (let i = 0; i <= altered.length - header.length; i++) {
      if (header.every((value, index) => altered[i + index] === value)) { location = i; break }
    }
    if (location < 0) throw new Error('ZIP does not contain the uncompressed database')
    altered[location + 128] ^= 0x7f
    let integrityError = ''
    try { await inspectBrowserBackup(altered) } catch (error) { integrityError = String(error) }

    let nonZipError = ''
    try { await inspectBrowserBackup(new Uint8Array(100)) } catch (error) { nonZipError = String(error) }

    const incoming = { providers: [
      { ...provider, base_url: 'https://untrusted.invalid/v1' },
      { ...provider, id: 'new-provider', name: 'Imported provider' },
    ], models: [
      model,
      { ...model, provider_id: 'new-provider' },
    ], selected_model_id: null }
    const additions = settingsAdditions(catalog, incoming)
    return {
      format: read.manifest.format,
      version: read.manifest.version,
      databaseBytes: read.database.length,
      providerCount: read.settings.providers.length,
      integrityError,
      nonZipError,
      additions,
    }
  }, { provider, model })
  expect(result).toMatchObject({
    format: 'cerachat-browser-backup', version: 1, databaseBytes: 4096, providerCount: 1,
  })
  expect(result.integrityError).toMatch(/checksum mismatch/i)
  expect(result.nonZipError).toMatch(/zip|archive|backup/i)
  expect(result.additions.providers.map((entry) => entry.id)).toEqual(['new-provider'])
  expect(result.additions.models.map((entry) => entry.provider_id)).toEqual(['new-provider'])
})

test('user-initiated ZIP export, replace confirmation and restore preserve conversations without exporting API keys', async ({ page }) => {
  await page.goto('/')
  const original = await page.evaluate(async ({ provider, model }) => {
    const backend = await import('/src/lib/backend.ts')
    const conversation = await backend.createConversation()
    await backend.addTextSource(conversation.id, 'backup-source.txt', 'A local private source')
    // Even a key explicitly persisted on this device must stay out of ZIPs.
    await backend.saveProvider(provider, 'do-not-export-this-api-key', true)
    await backend.saveModel(model)
    return conversation
  }, { provider, model })
  await page.reload()
  await page.getByRole('button', { name: 'Backups and storage' }).click()
  const modal = page.getByRole('dialog', { name: 'Browser backups and storage' })
  await expect(modal).toBeVisible()
  await expect(modal.getByRole('button', { name: 'Request persistent storage' })).toBeVisible()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    modal.getByRole('button', { name: 'Download backup ZIP' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/^cerachat-backup-.*\.zip$/)
  const zipped = await readFile(await download.path())
  expect(zipped.length).toBeGreaterThan(1024)
  expect(zipped.includes(Buffer.from('do-not-export-this-api-key'))).toBe(false)
  await modal.getByRole('button', { name: 'Close', exact: true }).last().click()

  await page.evaluate(async (id) => (await import('/src/lib/backend.ts')).deleteConversation(id), original.id)
  const beforeRestore = await page.evaluate(async () => (await import('/src/lib/backend.ts')).bootstrap())
  expect(beforeRestore.conversations.some((row) => row.id === original.id)).toBe(false)

  await page.getByRole('button', { name: 'Backups and storage' }).click()
  const restoreModal = page.getByRole('dialog', { name: 'Browser backups and storage' })
  await restoreModal.locator('input[type="file"]').setInputFiles({
    name: 'saved.zip', mimeType: 'application/zip', buffer: zipped,
  })
  await expect(restoreModal.getByText('saved.zip')).toBeVisible()
  const prompt = page.waitForEvent('dialog').then((dialog) => {
    expect(dialog.message()).toMatch(/REPLACE.*conversation history/i)
    return dialog.accept()
  })
  await restoreModal.getByRole('button', { name: 'Replace browser conversations with this backup' }).click()
  await prompt
  await expect(page.getByRole('button', { name: 'Backups and storage' })).toBeVisible()
  await expect(restoreModal).toHaveCount(0)
  const restored = await page.evaluate(async () => (await import('/src/lib/backend.ts')).bootstrap())
  expect(restored.conversations.some((row) => row.id === original.id)).toBe(true)
  expect(restored.sources.some((source) => source.display_name === 'backup-source.txt')).toBe(true)
})

test('a self-consistent ZIP containing corrupt SQLite cannot replace the current workspace', async ({ page }) => {
  await page.goto('/')
  const prepared = await page.evaluate(async () => {
    const backend = await import('/src/lib/backend.ts')
    const backup = await import('/src/lib/browserBackup.ts')
    const conversation = await backend.createConversation()
    const malformedDatabase = new Uint8Array(4096)
    malformedDatabase.set(new TextEncoder().encode('SQLite format 3\0'))
    const zip = await backup.packBrowserBackup(malformedDatabase, (await backend.bootstrap()).provider_catalog)
    return { conversationId: conversation.id, zip: Array.from(zip) }
  })
  await page.getByRole('button', { name: 'Backups and storage' }).click()
  const modal = page.getByRole('dialog', { name: 'Browser backups and storage' })
  await modal.locator('input[type="file"]').setInputFiles({
    name: 'invalid-database.zip', mimeType: 'application/zip', buffer: Buffer.from(prepared.zip),
  })
  await expect(modal.getByText('invalid-database.zip')).toBeVisible()
  const confirmation = page.waitForEvent('dialog').then((dialog) => dialog.accept())
  await modal.getByRole('button', { name: 'Replace browser conversations with this backup' }).click()
  await confirmation
  await expect(modal.getByRole('alert')).toBeVisible()
  const after = await page.evaluate(async () => (await import('/src/lib/backend.ts')).bootstrap())
  expect(after.conversations.some((conversation) => conversation.id === prepared.conversationId)).toBe(true)
})

test('optional imported settings add missing providers without altering existing keys or profiles', async ({ page }) => {
  await page.goto('/')
  const prepared = await page.evaluate(async ({ provider, model }) => {
    const backend = await import('/src/lib/backend.ts')
    const storage = await import('/src/lib/browserStorage.ts')
    const backup = await import('/src/lib/browserBackup.ts')
    await backend.saveProvider(provider, 'keep-this-api-key', true)
    await backend.saveModel(model)
    await backend.createConversation()
    const incomingProvider = { ...provider, id: 'imported', name: 'Imported from archive', base_url: 'https://imported.invalid/v1' }
    const incoming = {
      providers: [{ ...provider, base_url: 'https://malicious.invalid/v1' }, incomingProvider],
      models: [model, { ...model, provider_id: 'imported' }],
      selected_model_id: 'imported::test' as const,
    }
    const zip = await backup.packBrowserBackup(await storage.exportSnapshot(), incoming)
    return { zip: Array.from(zip) }
  }, { provider, model })
  await page.getByRole('button', { name: 'Backups and storage' }).click()
  const modal = page.getByRole('dialog', { name: 'Browser backups and storage' })
  await modal.locator('input[type="file"]').setInputFiles({
    name: 'provider-import.zip', mimeType: 'application/zip', buffer: Buffer.from(prepared.zip),
  })
  await modal.getByLabel(/Add missing provider settings from this backup/).check()
  const confirmation = page.waitForEvent('dialog').then((dialog) => dialog.accept())
  await modal.getByRole('button', { name: 'Replace browser conversations with this backup' }).click()
  await confirmation
  await expect(modal).toHaveCount(0)
  const restored = await page.evaluate(async () => {
    const backend = await import('/src/lib/backend.ts')
    const state = await backend.bootstrap()
    const raw = localStorage.getItem(backend.BROWSER_PROVIDER_STORAGE_KEY) ?? ''
    return { state, raw, remembered: backend.browserProviderKeyPersistence('backuptest') }
  })
  expect(restored.state.provider_catalog.providers.find((item) => item.id === provider.id)?.base_url).toBe(provider.base_url)
  expect(restored.state.provider_catalog.providers.find((item) => item.id === 'imported')?.base_url).toBe('https://imported.invalid/v1')
  expect(restored.state.provider_catalog.models.some((item) => item.provider_id === 'imported')).toBe(true)
  expect(restored.state.provider_catalog.selected_model_id).toBeNull()
  expect(restored.raw).toContain('keep-this-api-key')
  expect(restored.remembered).toBe(true)
})
