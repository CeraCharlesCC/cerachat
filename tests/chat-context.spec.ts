import { expect, test, type Page } from '@playwright/test'

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

test('editing a user creates a sibling, preserves descendants, and generates without duplicating the user', async ({ page }) => {
  await openWithModel(page)
  const external: string[] = []
  page.on('request', (request) => { if (!request.url().startsWith('http://127.0.0.1:4173/')) external.push(request.url()) })
  const before = await page.evaluate(async () => (await import('/src/lib/backend.ts')).getMessages('demo-chat'))
  await page.getByRole('button', { name: 'Edit message', exact: true }).first().click()
  const editor = page.getByRole('dialog', { name: 'Edit message' })
  const save = editor.getByRole('button', { name: 'Save as new branch' })
  await expect(save).toBeDisabled()
  await editor.getByLabel('Edited message').fill('  ')
  await expect(save).toBeDisabled()
  await editor.getByLabel('Edited message').fill('Edited prompt 日本語')
  await save.click()
  await expect(editor).toHaveCount(0)
  await expect(page.getByRole('main').locator('article')).toHaveCount(1)
  const after = await page.evaluate(async () => (await import('/src/lib/backend.ts')).getMessages('demo-chat'))
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
  const generated = await page.evaluate(async () => (await import('/src/lib/backend.ts')).getMessages('demo-chat'))
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
  await expect(page.getByRole('dialog', { name: 'Edit message' })).toHaveCount(0)
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
