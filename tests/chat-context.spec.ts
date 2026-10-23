import { expect, test, type Page } from '@playwright/test'
import type { Message } from '../src/types'

async function browserMessages(page: Page): Promise<Message[]> {
  return page.evaluate(async () => {
    // A reused Vite server may serve the app's backend with an HMR timestamp.
    // Import that same module instance so the assertions read the app's state.
    const url = performance.getEntriesByType('resource').map((entry) => entry.name)
      .find((name) => new URL(name).pathname === '/src/lib/backend.ts')
    if (!url) throw new Error('The browser backend has not loaded')
    return (await import(url)).getMessages('demo-chat')
  })
}

async function openWithModel(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('cerachat.provider-catalog.v1', JSON.stringify({
      version: 1,
      settings: {
        providers: [{ id: 'local', name: 'Local', protocol: 'openai_chat_completions', base_url: 'https://unused.invalid/v1', api_key_storage: 'plain_portable', system_text: '', temperature: null, raw_json_overrides: '{}', context_separator: '\n---\n' }],
        models: [{ provider_id: 'local', model_id: 'test', name: 'Test', context_window: 128000, max_output_tokens: 1024 }],
        selected_model_id: 'local::test',
      },
      secrets: { api_keys: { local: '' } },
    }))
  })
  await page.goto('/')
  await expect(page.getByRole('main').getByRole('button', { name: /Test/ }).first()).toBeVisible()
}

async function clearAttachments(page: Page) {
  const remove = page.getByRole('button', { name: 'Remove context slice', exact: true })
  while (await remove.count()) {
    await expect(remove.first()).toBeEnabled()
    const count = await remove.count()
    await remove.first().click()
    await expect(remove).toHaveCount(count - 1)
  }
}

async function pasteText(page: Page, name: string, text: string) {
  await page.getByRole('button', { name: 'Paste text', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Paste text' })
  await dialog.getByLabel('File name', { exact: true }).fill(name)
  await dialog.getByLabel('Text', { exact: true }).fill(text)
  await dialog.getByRole('button', { name: 'Add text', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

async function previewCurrent(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Request preview' })
  await expect(dialog).toBeVisible()
  const raw = await dialog.locator('pre').first().textContent()
  const request = JSON.parse(raw ?? '{}') as { messages: { role: string; content: string }[] }
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  return request.messages[request.messages.length - 1].content
}

test('editing a user inline creates a sibling, preserves descendants, and generates without duplicating the user', async ({ page }) => {
  await openWithModel(page)
  const external: string[] = []
  page.on('request', (request) => { if (!request.url().startsWith('http://127.0.0.1:4173/')) external.push(request.url()) })
  const before = await browserMessages(page)
  await page.getByRole('button', { name: 'Edit message', exact: true }).first().click()
  const editor = page.getByRole('article', { name: 'User message' }).first().getByRole('form', { name: 'Edit message' })
  await expect(page.getByRole('dialog', { name: 'Edit message' })).toHaveCount(0)
  await expect(editor.getByLabel('Edited message')).toBeFocused()
  const save = editor.getByRole('button', { name: 'Save as new branch' })
  await expect(save).toBeDisabled()
  await editor.getByLabel('Edited message').fill('  ')
  await expect(save).toBeDisabled()
  await editor.getByLabel('Edited message').fill('Edited prompt 日本語')
  await save.click()
  await expect(page.getByRole('form', { name: 'Edit message' })).toHaveCount(0)
  await expect(page.getByRole('main').locator('article')).toHaveCount(1)
  const after = await browserMessages(page)
  expect(after).toHaveLength(before.length + 1)
  for (const message of before) expect(after.find((item) => item.id === message.id)).toEqual(message)
  const edited = after.find((message) => message.content === 'Edited prompt 日本語')!
  expect(edited.parent_id).toBeNull()
  expect(edited.role).toBe('user')
  await page.getByRole('button', { name: 'Previous branch', exact: true }).click()
  await expect(page.getByRole('main').locator('article')).toHaveCount(4)
  await page.getByRole('button', { name: 'Next branch', exact: true }).first().click()
  await expect(page.getByRole('main').locator('article')).toHaveCount(1)
  await page.getByRole('button', { name: 'Generate response', exact: true }).click()
  await expect(page.getByRole('main').locator('article')).toHaveCount(2)
  const generated = await browserMessages(page)
  expect(generated).toHaveLength(before.length + 2)
  expect(generated.filter((message) => message.content === edited.content)).toHaveLength(1)
  expect(generated.find((message) => message.parent_id === edited.id)?.role).toBe('assistant')
  expect(external).toEqual([])
})

test('assistant edits can be cancelled, branch independently, and survive conversation switches', async ({ page }) => {
  await openWithModel(page)
  const articles = page.getByRole('main').locator('article')
  await articles.last().getByRole('button', { name: 'Edit message' }).click()
  await page.getByLabel('Edited message').fill('Unsaved content')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('form', { name: 'Edit message' })).toHaveCount(0)
  await expect(articles.last().getByRole('button', { name: 'Edit message' })).toBeFocused()
  await expect(articles.last()).not.toContainText('Unsaved content')
  await articles.last().getByRole('button', { name: 'Edit message' }).click()
  await page.getByLabel('Edited message').fill('A saved assistant alternative')
  await page.getByRole('button', { name: 'Save as new branch' }).click()
  await expect(articles.last()).toContainText('A saved assistant alternative')
  await page.locator('#threads-panel').getByRole('button', { name: 'Large log review', exact: true }).click()
  await expect(articles).toHaveCount(0)
  await page.locator('#threads-panel').getByRole('button', { name: 'Deterministic request architecture', exact: true }).click()
  await expect(articles.last()).toContainText('A saved assistant alternative')
})

test('inline editing keeps the composer draft and handles newlines, IME, cancellation, and keyboard save', async ({ page }) => {
  await openWithModel(page)
  const draft = page.getByRole('textbox', { name: 'Message input', exact: true })
  await draft.fill('Unsent draft 日本語')
  const before = await browserMessages(page)
  const user = page.getByRole('article', { name: 'User message' }).last()
  await user.hover()
  await user.getByRole('button', { name: 'Edit message', exact: true }).click()
  const editor = user.getByRole('form', { name: 'Edit message' })
  const text = editor.getByLabel('Edited message')
  await text.fill('**Literal prompt** 日本語')
  await text.press('End')
  await text.press('Enter')
  await text.press('Shift+Enter')
  await expect(text).toHaveValue('**Literal prompt** 日本語\n\n')
  await text.dispatchEvent('keydown', { key: 'Escape', isComposing: true })
  await text.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true })
  await text.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, keyCode: 229 })
  await expect(editor).toBeVisible()
  expect(await browserMessages(page)).toEqual(before)
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toBeDisabled()
  await expect(draft).toHaveValue('Unsent draft 日本語')
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(user.getByRole('button', { name: 'Edit message', exact: true })).toBeFocused()
  await user.getByRole('button', { name: 'Edit message', exact: true }).click()
  await expect(text).toHaveValue(before.find((message) => message.id === 'u2')!.content)
  await text.fill('**Literal prompt** 日本語\nSecond line')
  await text.press('Control+Enter')
  await expect(page.getByRole('form', { name: 'Edit message' })).toHaveCount(0)
  await expect(user).toContainText('**Literal prompt** 日本語')
  await expect(user.locator('strong')).toHaveCount(0)
  await expect(draft).toHaveValue('Unsent draft 日本語')
  await expect(draft).toBeFocused()
  expect(await browserMessages(page)).toHaveLength(before.length + 1)
})

test('failed inline saves retain the edit and allow retry on a compact screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route('**/src/lib/backend.ts*', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, body: `${await response.text()}\nconst originalEditMessage = editMessage;
      let failEdit = true;
      editMessage = async (...args) => {
        if (failEdit) { failEdit = false; throw new Error('Could not save edit'); }
        return originalEditMessage(...args);
      };` })
  })
  await openWithModel(page)
  const user = page.getByRole('article', { name: 'User message' }).last()
  await user.getByRole('button', { name: 'Edit message', exact: true }).click()
  const editor = user.getByRole('form', { name: 'Edit message' })
  const content = Array.from({ length: 30 }, (_, index) => `Line ${index}: 日本語の編集 ${'long'.repeat(20)}`).join('\n')
  await editor.getByLabel('Edited message').fill(content)
  await editor.getByRole('button', { name: 'Save as new branch' }).click()
  await expect(editor.getByRole('alert')).toContainText('Could not save edit')
  await expect(editor.getByLabel('Edited message')).toHaveValue(content)
  await expect(editor.getByRole('button', { name: 'Save as new branch' })).toBeEnabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  const box = (await editor.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await editor.getByRole('button', { name: 'Save as new branch' }).click()
  await expect(page.getByRole('form', { name: 'Edit message' })).toHaveCount(0)
  await expect(user).toContainText('Line 29: 日本語の編集')
})

test('attachment arrows and drag order change compiled text, with separators, positions, and no duplicate includes', async ({ page }) => {
  await openWithModel(page)
  await clearAttachments(page)
  await pasteText(page, 'first.txt', 'FIRST')
  await pasteText(page, 'second.txt', 'SECOND\n末尾')
  const list = page.getByRole('list', { name: 'Ordered attachments' })
  await expect(list.getByRole('listitem')).toHaveCount(2)
  await page.getByLabel('Message input').fill('QUESTION')
  expect(await previewCurrent(page)).toBe('QUESTION\n---\n===== FILE: first.txt =====\nFIRST\n---\n===== FILE: second.txt =====\nSECOND\n末尾')
  await list.getByRole('listitem').last().getByRole('button', { name: 'Move context slice up', exact: true }).click()
  await expect(list.getByRole('listitem').first()).toContainText('second.txt')
  expect(await previewCurrent(page)).toContain('SECOND\n末尾\n---\n===== FILE: first.txt =====\nFIRST')
  const handles = page.getByLabel(/Drag attachment/)
  await handles.first().dragTo(list.getByRole('listitem').last())
  await expect(list.getByRole('listitem').first()).toContainText('first.txt')
  await page.getByRole('button', { name: 'Include all of first.txt', exact: true }).click()
  await expect(list.getByRole('listitem')).toHaveCount(2)
  await list.getByRole('listitem').first().getByLabel('Context insertion point').selectOption('before_current')
  await expect(list.getByRole('listitem').first().getByLabel('Context insertion point')).toHaveValue('before_current')
  expect(await previewCurrent(page)).toBe('===== FILE: first.txt =====\nFIRST\n---\nQUESTION\n---\n===== FILE: second.txt =====\nSECOND\n末尾')
})

test('source viewer validates ranges and previews the selected lines including trailing empty lines', async ({ page }) => {
  await openWithModel(page)
  await clearAttachments(page)
  await pasteText(page, 'lines.txt', 'one\r\ntwo\n')
  await page.locator('#context-panel').getByRole('button', { name: /lines.txt.*lines/ }).click()
  const viewer = page.getByRole('dialog', { name: 'lines.txt', exact: true })
  await expect(viewer.getByText('3 lines', { exact: false }).first()).toBeVisible()
  await viewer.getByLabel('Include', { exact: true }).selectOption('lines')
  await viewer.getByLabel('To line', { exact: true }).fill('4')
  await expect(viewer.getByRole('button', { name: 'Add to context' })).toBeDisabled()
  await viewer.getByLabel('From line', { exact: true }).fill('2')
  await viewer.getByLabel('To line', { exact: true }).fill('3')
  await viewer.getByLabel('Format', { exact: true }).selectOption('raw')
  await viewer.getByRole('button', { name: 'Add to context' }).click()
  const list = page.getByRole('list', { name: 'Ordered attachments' })
  await expect(list.getByRole('listitem')).toHaveCount(2)
  await list.getByRole('listitem').first().getByRole('button', { name: 'Remove context slice' }).click()
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await page.getByLabel('Message input').fill('QUESTION')
  expect(await previewCurrent(page)).toBe('QUESTION\n---\ntwo\n')
})

test('compact context supports paste and reorder without overflowing the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openWithModel(page)
  await page.getByRole('button', { name: 'Context', exact: true }).click()
  await clearAttachments(page)
  await pasteText(page, 'mobile.txt', 'MOBILE')
  const list = page.getByRole('list', { name: 'Ordered attachments' })
  await expect(list).toContainText('mobile.txt')
  const box = await page.locator('#context-panel').boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
})

test('source libraries share all branches, isolate chats, and allow explicit reuse with independent removal', async ({ page }) => {
  await openWithModel(page)
  await clearAttachments(page)
  await pasteText(page, 'private.txt', 'CHAT_A_ONLY')
  const library = page.locator('#source-library')
  const list = page.getByRole('list', { name: 'Ordered attachments' })
  const threads = page.locator('#threads-panel')
  await page.getByRole('button', { name: 'Previous branch', exact: true }).click()
  await expect(library).toContainText('private.txt')
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await page.getByLabel('Message input').fill('QUESTION')
  expect(await previewCurrent(page)).toContain('CHAT_A_ONLY')

  await threads.getByRole('button', { name: 'Large log review', exact: true }).click()
  await expect(library).not.toContainText('private.txt')
  await expect(list.getByRole('listitem')).toHaveCount(0)
  await page.getByLabel('Message input').fill('QUESTION_B')
  expect(await previewCurrent(page)).toBe('QUESTION_B')
  // Include all remains scoped even though another chat has multiple sources.
  await pasteText(page, 'b.txt', 'CHAT_B_ONLY')
  await page.getByRole('button', { name: 'Include all sources', exact: true }).click()
  await expect(list.getByRole('listitem')).toHaveCount(1)
  expect(await previewCurrent(page)).toBe('QUESTION_B\n---\n===== FILE: b.txt =====\nCHAT_B_ONLY')

  await page.getByRole('button', { name: 'Add from another chat', exact: true }).click()
  let picker = page.getByRole('dialog', { name: 'Add from another chat' })
  await picker.getByLabel('Search chats and sources').fill('private.txt')
  await expect(picker.getByRole('button', { name: /^Add .* from / })).toHaveCount(1)
  await picker.getByRole('button', { name: 'Add private.txt from Deterministic request architecture', exact: true }).click()
  await expect(picker).toHaveCount(0)
  await expect(library).toContainText('private.txt')
  await expect(list.getByRole('listitem')).toHaveCount(2)
  expect(await previewCurrent(page)).toContain('CHAT_A_ONLY')
  await list.getByRole('listitem').last().getByRole('button', { name: 'Move context slice up', exact: true }).click()
  await expect(list.getByRole('listitem').first()).toContainText('private.txt')

  // Reusing the same source again does not duplicate it or its attachment.
  await page.getByRole('button', { name: 'Add from another chat', exact: true }).click()
  picker = page.getByRole('dialog', { name: 'Add from another chat' })
  await picker.getByRole('button', { name: 'Add private.txt from Deterministic request architecture', exact: true }).click()
  await expect(picker).toHaveCount(0)
  await expect(library.getByRole('button', { name: 'Include all of private.txt', exact: true })).toHaveCount(1)
  await expect(list.getByRole('listitem')).toHaveCount(2)

  await threads.getByRole('button', { name: 'Deterministic request architecture', exact: true }).click()
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await expect(library).not.toContainText('b.txt')
  page.once('dialog', (dialog) => dialog.accept())
  await library.getByRole('button', { name: 'Remove private.txt', exact: true }).click()
  await expect(library).not.toContainText('private.txt')
  await threads.getByRole('button', { name: 'Large log review', exact: true }).click()
  await expect(list.getByRole('listitem')).toHaveCount(2)
  expect(await previewCurrent(page)).toContain('CHAT_A_ONLY')
  await threads.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(library.getByRole('button')).toHaveCount(0)
  await expect(list.getByRole('listitem')).toHaveCount(0)
})

test('cross-chat reuse respects automatic inclusion being off', async ({ page }) => {
  await openWithModel(page)
  await page.locator('#threads-panel').getByRole('button', { name: 'Large log review', exact: true }).click()
  await page.getByText('New attachment options', { exact: true }).click()
  await page.getByLabel('Include imported files automatically').uncheck()
  await page.getByRole('button', { name: 'Add from another chat', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Add from another chat' })
  await picker.getByRole('button', { name: 'Add instructions.txt from Deterministic request architecture', exact: true }).click()
  await expect(picker).toHaveCount(0)
  await expect(page.locator('#source-library')).toContainText('instructions.txt')
  await expect(page.getByRole('list', { name: 'Ordered attachments' }).getByRole('listitem')).toHaveCount(0)
  await page.getByLabel('Message input').fill('QUESTION')
  expect(await previewCurrent(page)).toBe('QUESTION')
})
