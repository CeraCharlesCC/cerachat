import { expect, test } from '@playwright/test'
import { zipSync, strToU8 } from 'fflate'

test('Add files opens the picker, imports text and ZIP entries, and preserves context after reload', async ({ page }) => {
  await page.goto('/')
  const context = page.locator('#context-panel')
  const pickerPromise = page.waitForEvent('filechooser')
  await context.getByRole('button', { name: 'Add files', exact: true }).click()
  const picker = await pickerPromise
  const files = [
    { name: 'local.txt', mimeType: 'text/plain', buffer: Buffer.from('alpha\r\n日本語\n') },
    { name: 'logs.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync({
      'folder/trace.LOG': strToU8('log line\n'),
      'folder/note.md': strToU8('notes'),
      'ignored.png': new Uint8Array([1, 2, 3]),
      '../unsafe.txt': strToU8('ignored'),
    })) },
  ]
  await picker.setFiles(files)
  const sources = context.locator('#source-library')
  for (const name of ['local.txt', 'logs.zip / folder/trace.LOG', 'logs.zip / folder/note.md']) {
    await expect(sources.getByText(name, { exact: true })).toBeVisible()
  }
  await expect(sources.getByText('ignored.png')).toHaveCount(0)
  await expect(sources.getByText('unsafe.txt')).toHaveCount(0)
  const snapshot = () => page.evaluate(async () => {
    const backend = await import('/src/lib/backend.ts')
    const state = await backend.bootstrap()
    const sources = state.sources.filter(source => source.origin_path === 'local.txt' || source.origin_path === 'logs.zip')
    return Promise.all(sources.map(async source => ({
      ...source, lines: (await backend.getSourceLines(source.id)).lines,
      slices: state.slices.filter(slice => slice.source_id === source.id),
    })))
  })
  const first = await snapshot()
  expect(first).toHaveLength(3)
  expect(first.find(source => source.display_name === 'local.txt')?.lines).toEqual(['alpha\r', '日本語', ''])
  expect(first.find(source => source.display_name.endsWith('trace.LOG'))?.archive_path).toBe('folder/trace.LOG')
  expect(first.every(source => source.slices.length === 1 && source.slices[0].enabled)).toBe(true)
  await context.getByLabel('Choose context files').setInputFiles(files)
  await expect(context.getByRole('button', { name: 'Add files', exact: true })).toBeEnabled()
  expect(await snapshot()).toEqual(first)
  await page.reload()
  await expect(sources.getByText('local.txt', { exact: true })).toBeVisible()
  expect(await snapshot()).toEqual(first)

  await page.evaluate(async () => {
    const backend = await import('/src/lib/backend.ts')
    await backend.saveProvider({ id: 'files', name: 'Files', protocol: 'openai_chat_completions',
      base_url: 'https://files.invalid/v1', api_key_storage: 'plain_portable', system_text: '', context_separator: '\n---\n' }, '')
    await backend.saveModel({ provider_id: 'files', model_id: 'text', name: 'Text', context_window: 5000,
      max_output_tokens: 100, temperature: null, raw_json_overrides: '{}' })
    await backend.selectModel('files::text')
  })
  await page.reload()
  await page.getByLabel('Message input').fill('Read the files')
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  const preview = page.getByRole('dialog', { name: 'Request preview' })
  const json = JSON.parse((await preview.locator('pre').first().textContent())!)
  expect(json.messages.at(-1).content).toContain('alpha\r\n日本語\n')
  expect(json.messages.at(-1).content).toContain('log line\n')
  expect(json.messages.at(-1).content).toContain('notes')
})

test('context drop respects auto-include, and bad selections do not partially import', async ({ page }) => {
  await page.goto('/')
  const context = page.locator('#context-panel')
  await context.getByText('New attachment options', { exact: true }).click()
  await context.getByLabel('Include imported files automatically').uncheck()
  const before = await context.getByRole('list', { name: 'Ordered attachments' }).getByRole('listitem').count()
  await context.evaluate(element => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['dropped text'], 'dropped.md'))
    element.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
  })
  await expect(context.locator('#source-library').getByText('dropped.md', { exact: true })).toBeVisible()
  await expect(context.getByRole('list', { name: 'Ordered attachments' }).getByRole('listitem')).toHaveCount(before)
  const picker = context.getByLabel('Choose context files')
  await picker.setInputFiles([
    { name: 'valid.txt', mimeType: 'text/plain', buffer: Buffer.from('would be imported') },
    { name: 'bad.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip') },
  ])
  await expect(page.getByRole('alert')).toContainText('invalid ZIP')
  await expect(context.locator('#source-library').getByText('valid.txt', { exact: true })).toHaveCount(0)
  await picker.setInputFiles({ name: 'big.txt', mimeType: 'text/plain', buffer: Buffer.alloc(16 * 1024 * 1024 + 1) })
  await expect(page.getByRole('alert')).toContainText('16 MiB')
  await picker.setInputFiles({ name: 'unsupported.pdf', mimeType: 'application/pdf', buffer: Buffer.from('pdf') })
  await expect(page.getByRole('alert')).toContainText('No supported')
  await picker.setInputFiles({ name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) })
  await expect(context.locator('#source-library').getByText('empty.txt', { exact: true })).toBeVisible()
  await context.getByRole('button', { name: 'Include all of empty.txt' }).click()
  await expect(context.getByRole('list', { name: 'Ordered attachments' }).getByRole('listitem')).toHaveCount(before + 1)
  await picker.setInputFiles({ name: 'utf16.txt', mimeType: 'text/plain', buffer: Buffer.concat([Buffer.from([255, 254]), Buffer.from('日本語', 'utf16le')]) })
  await expect(context.locator('#source-library').getByText('utf16.txt', { exact: true })).toBeVisible()
  const lines = await page.evaluate(async () => {
    const backend = await import('/src/lib/backend.ts')
    const state = await backend.bootstrap()
    const source = state.sources.find(source => source.display_name === 'utf16.txt')!
    return backend.getSourceLines(source.id)
  })
  expect(lines.lines).toEqual(['日本語'])
  await expect(page.getByRole('alert')).toHaveCount(0)
})
