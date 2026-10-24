import { expect, test, type Page } from '@playwright/test'
import type { StreamPayload } from '../src/types'

async function openWithStream(page: Page, protocol: 'openai_responses' | 'openai_chat_completions' = 'openai_responses') {
  await page.addInitScript((protocol) => {
    if (!localStorage.getItem('cerachat.provider-catalog.v1')) localStorage.setItem('cerachat.provider-catalog.v1', JSON.stringify({
      version: 1,
      settings: {
        providers: [{ id: 'local', name: 'Local', protocol, base_url: 'https://unused.invalid/v1', api_key_storage: 'plain_portable', system_text: '', temperature: null, raw_json_overrides: '{"reasoning":{"effort":"high"},"store":false}', context_separator: '\n---\n' }],
        models: [{ provider_id: 'local', model_id: 'test', name: 'Test', context_window: 128000, max_output_tokens: 1024 }],
        selected_model_id: 'local::test',
      },
      secrets: { api_keys: { local: '' } },
    }))
  }, protocol)
  // Feed provider events through the same subscription and store used by the app.
  // This hook exists only in the test response, never in production code.
  await page.route('**/src/lib/backend.ts*', async (route) => {
    const response = await route.fetch()
    const source = (await response.text()).replaceAll('await compileRequest(args);', 'window.__lastBrowserRequest = await compileRequest(args);')
    await route.fulfill({ response, body: `${source}\nwindow.__emitReasoning = (payload) => {
      if (payload.user_message) browserMessages.push(payload.user_message);
      if (payload.assistant_message) browserMessages.push(payload.assistant_message);
      emitBrowser(payload);
    };` })
  })
  await page.goto('/')
  await expect(page.getByRole('main').getByRole('button', { name: 'Test' }).first()).toBeVisible()
  await page.waitForFunction(() => '__emitReasoning' in window)
}

async function emit(page: Page, payload: StreamPayload) {
  await page.evaluate((event) => {
    (window as unknown as { __emitReasoning: (event: StreamPayload) => void }).__emitReasoning(event)
  }, payload)
}

const request = { request_id: 'reasoning-test', conversation_id: 'demo-chat' }

test('streams, folds, saves and restores reasoning separately from the answer and next request', async ({ page }) => {
  await openWithStream(page)
  await emit(page, { ...request, kind: 'started', user_message: { id: 'ru', conversation_id: 'demo-chat', parent_id: 'a2-alt', role: 'user', content: 'Reasoning question', include_next: true, created_at: Date.now() } })
  const first = { parts: [{ id: 's0', kind: 'summary' as const, text: 'Summary 日本語' }], tokens: null, encrypted: false }
  await emit(page, { ...request, kind: 'delta', reasoning: first })
  const messages = page.getByRole('region', { name: 'Conversation messages' })
  const panel = messages.locator('details[aria-label="Response reasoning"]').last()
  await expect(panel.locator('summary')).toHaveText('Reasoning summary')
  await expect(panel).not.toHaveAttribute('open', '')
  await panel.locator('summary').click()
  await expect(panel).toContainText('Summary 日本語')
  await expect(panel.getByRole('checkbox')).toBeDisabled()
  await expect(panel.getByRole('checkbox')).not.toBeChecked()
  await emit(page, { ...request, kind: 'delta', reasoning: { ...first, parts: [{ id: 's0', kind: 'summary', text: ' continued' }, { id: 't0', kind: 'text', text: 'Provider steps' }], tokens: 123, encrypted: true }, text: 'Visible answer' })
  await expect(panel).toContainText('Summary 日本語 continued')
  await expect(panel).toContainText('Provider steps')
  await expect(panel.locator('summary')).toHaveText('Reasoning 123 tokens')
  const saved = { parts: [{ id: 's0', kind: 'summary' as const, text: 'Summary 日本語 continued' }, { id: 't0', kind: 'text' as const, text: 'Provider steps' }], tokens: 123, encrypted: true }
  await emit(page, { ...request, kind: 'done', assistant_message: { id: 'ra', conversation_id: 'demo-chat', parent_id: 'ru', role: 'assistant', content: 'Visible answer', reasoning: saved, include_next: true, created_at: Date.now() } })
  await expect(messages.getByText('Streaming', { exact: true })).toHaveCount(0)
  await expect(messages.getByText('Visible answer', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Large log review', exact: true }).click()
  await page.getByRole('button', { name: 'Deterministic request architecture', exact: true }).click()
  await messages.locator('details[aria-label="Response reasoning"] summary').click()
  await expect(messages.locator('details[aria-label="Response reasoning"]')).toContainText('Summary 日本語 continued')
  await expect(messages.locator('details[aria-label="Response reasoning"]')).toContainText('protected reasoning')
  // The inspected history contains only the saved answer.
  await page.getByRole('textbox', { name: 'Message input', exact: true }).fill('Next question')
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  const preview = page.getByRole('dialog', { name: 'Request preview' }).locator('pre').first()
  await expect(preview).toContainText('Visible answer')
  await expect(preview).not.toContainText('Provider steps')
  await expect(preview).not.toContainText('Summary 日本語')
})

test('includes checked reasoning blocks in previews and the next send, and remembers choices per message', async ({ page }) => {
  await openWithStream(page)
  const createdAt = Date.now()
  await emit(page, { ...request, kind: 'started', user_message: { id: 'manual-user', conversation_id: 'demo-chat', parent_id: 'a2-alt', role: 'user', content: 'Manual reasoning question', include_next: true, created_at: createdAt } })
  await emit(page, { ...request, kind: 'done', assistant_message: {
    id: 'manual-answer', conversation_id: 'demo-chat', parent_id: 'manual-user', role: 'assistant', content: 'Manual answer', include_next: true, created_at: createdAt + 1,
    reasoning: { parts: [{ id: 'summary', kind: 'summary', text: 'Selected summary 日本語' }, { id: 'text', kind: 'text', text: 'Optional reasoning steps' }], tokens: 99, encrypted: true },
  } })
  const messages = page.getByRole('region', { name: 'Conversation messages' })
  const panel = messages.locator('details[aria-label="Response reasoning"]').last()
  await panel.locator('summary').click()
  const summary = panel.getByRole('checkbox', { name: 'Include reasoning summary in next request' })
  const text = panel.getByRole('checkbox', { name: 'Include reasoning text in next request' })
  await expect(summary).not.toBeChecked()
  await expect(text).not.toBeChecked()
  await summary.check()
  await expect(summary).toBeChecked()
  await expect(summary).toBeEnabled()
  await expect(panel).toContainText('Native raw')
  await page.getByRole('button', { name: 'Large log review', exact: true }).click()
  await page.getByRole('button', { name: 'Deterministic request architecture', exact: true }).click()
  await panel.locator('summary').click()
  await expect(summary).toBeChecked()
  await expect(text).not.toBeChecked()
  await page.getByRole('textbox', { name: 'Message input', exact: true }).fill('Next manual turn')
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  const preview = page.getByRole('dialog', { name: 'Request preview' })
  const raw = JSON.parse((await preview.locator('pre').first().textContent())!)
  const answer = raw.input.find((item: { role: string; content: string }) => item.role === 'assistant' && item.content.includes('Manual answer'))
  expect(answer.content).toBe('[Selected reasoning summary]\nSelected summary 日本語\n[/Selected reasoning summary]\n\nManual answer')
  expect(JSON.stringify(raw)).not.toContain('Optional reasoning steps')
  expect(JSON.stringify(raw)).not.toContain('encrypted')
  await preview.locator('summary', { hasText: 'Compiled prompt audit view' }).click()
  await expect(preview.locator('pre').nth(1)).toContainText(answer.content)
  await preview.getByRole('button', { name: 'Close', exact: true }).click()

  // The whole-message gate and the history mode still control selected blocks.
  const message = messages.getByRole('article', { name: 'Assistant message' }).filter({ hasText: 'Manual answer' })
  await message.getByRole('button', { name: 'Include message in request history', exact: true }).click()
  await expect(summary).toBeDisabled()
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  await expect(preview.locator('pre').first()).not.toContainText('Selected summary 日本語')
  await preview.getByRole('button', { name: 'Close', exact: true }).click()
  await message.getByRole('button', { name: 'Include message in request history', exact: true }).click()
  await expect(summary).toBeEnabled()
  await page.getByRole('combobox', { name: 'History', exact: true }).selectOption('no_history')
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  await expect(preview.locator('pre').first()).not.toContainText('Selected summary 日本語')
  await preview.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('combobox', { name: 'History', exact: true }).selectOption('full')

  await summary.uncheck()
  await text.check()
  await expect(text).toBeEnabled()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __lastBrowserRequest?: { request_json: string } }).__lastBrowserRequest?.request_json ?? '')).toContain('Optional reasoning steps')
  const sent = await page.evaluate(() => (window as unknown as { __lastBrowserRequest: { request_json: string } }).__lastBrowserRequest.request_json)
  expect(sent).not.toContain('Selected summary 日本語')
  expect(sent).not.toContain('[Selected reasoning text]')
  expect(JSON.parse(sent).input.some((item: { type?: string; content?: { type: string; text: string }[] }) => item.type === 'reasoning' && item.content?.[0].text === 'Optional reasoning steps')).toBe(true)
  await expect(messages.locator('details[aria-label="Response reasoning"]').last()).toContainText('Browser demo')
})

test('explains usage-only reasoning and leaves ordinary answers uncluttered', async ({ page }) => {
  await openWithStream(page)
  const messages = page.getByRole('region', { name: 'Conversation messages' })
  await expect(messages.locator('details[aria-label="Response reasoning"]')).toHaveCount(0)
  await emit(page, { ...request, kind: 'started' })
  await emit(page, { ...request, kind: 'delta', reasoning: { parts: [], tokens: 456, encrypted: false } })
  const panel = messages.locator('details[aria-label="Response reasoning"]')
  await expect(panel.locator('summary')).toContainText('456 tokens')
  await panel.locator('summary').click()
  await expect(panel).toContainText('did not return visible reasoning text')
})

test('streaming follows the bottom, preserves a reader scrolling up, and offers a jump back', async ({ page }) => {
  await openWithStream(page)
  const messages = page.getByRole('region', { name: 'Conversation messages' })
  const jump = page.getByRole('button', { name: 'Scroll to latest message' })
  const bottomGap = () => messages.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)
  await emit(page, { ...request, kind: 'started' })
  await emit(page, { ...request, kind: 'delta', text: 'A long response\n\n'.repeat(80) })
  await expect.poll(bottomGap).toBeLessThan(48)
  await expect(jump).toHaveCount(0)
  await messages.hover()
  await page.mouse.wheel(0, -700)
  await expect(jump).toBeVisible()
  const readingPosition = await messages.evaluate((element) => element.scrollTop)
  await emit(page, { ...request, kind: 'delta', text: 'More response\n\n'.repeat(40) })
  await expect.poll(() => messages.evaluate((element) => element.scrollTop)).toBe(readingPosition)
  await jump.click()
  await expect.poll(bottomGap).toBeLessThan(48)
  await expect(jump).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Message input', exact: true })).toBeFocused()
  await emit(page, { ...request, kind: 'delta', text: 'The final section\n\n'.repeat(20) })
  await expect.poll(bottomGap).toBeLessThan(48)
})

test('summary setting preserves other overrides, survives reload, and appears in request preview', async ({ page }) => {
  await openWithStream(page)
  const external: string[] = []
  page.on('request', (req) => { if (!req.url().startsWith('http://127.0.0.1:4173/')) external.push(req.url()) })
  await page.getByRole('main').getByRole('button', { name: 'Provider settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Provider settings' })
  await settings.getByRole('button', { name: 'Test test', exact: true }).click()
  await settings.getByRole('switch', { name: 'Enable Reasoning summary', exact: true }).click()
  await settings.getByLabel('Reasoning summary', { exact: true }).fill('auto')
  expect(JSON.parse(await settings.getByLabel('Raw JSON overrides').inputValue())).toEqual({ reasoning: { effort: 'high', summary: 'auto' }, store: false })
  await settings.getByRole('button', { name: 'Save model', exact: true }).click()
  await settings.getByRole('button', { name: 'Done', exact: true }).click()
  await page.reload()
  await page.getByRole('main').getByRole('button', { name: 'Provider settings', exact: true }).click()
  await settings.getByRole('button', { name: 'Test test', exact: true }).click()
  await expect(settings.getByLabel('Reasoning summary', { exact: true })).toHaveValue('auto')
  await settings.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('textbox', { name: 'Message input', exact: true }).fill('Question')
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  const raw = await page.getByRole('dialog', { name: 'Request preview' }).locator('pre').first().textContent()
  expect(JSON.parse(raw!).reasoning).toEqual({ effort: 'high', summary: 'auto' })
  expect(external).toEqual([])
})


for (const protocol of ['openai_chat_completions', 'openai_responses'] as const) {
  test(`${protocol}: edits raw reasoning as a branch and pairs the next intervention without quoting it`, async ({ page }) => {
    await openWithStream(page, protocol)
    await emit(page, { ...request, kind: 'started', user_message: { id: 'raw-user', conversation_id: 'demo-chat', parent_id: 'a2-alt', role: 'user', content: 'Work on the draft', include_next: true, created_at: 1 } })
    await emit(page, { ...request, kind: 'done', assistant_message: {
      id: 'raw-answer', conversation_id: 'demo-chat', parent_id: 'raw-user', role: 'assistant', content: 'Original answer', include_next: true, created_at: 2,
      reasoning: { parts: [{ id: 'raw', kind: 'text', text: '  First plan\n日本語\n', include_next: true }], tokens: 42, encrypted: false },
    } })
    const messages = page.getByRole('region', { name: 'Conversation messages' })
    const original = messages.getByRole('article', { name: 'Assistant message' }).filter({ hasText: 'Original answer' })
    await original.locator('details[aria-label="Response reasoning"] summary').click()
    await original.getByRole('button', { name: 'Edit reasoning', exact: true }).click()
    const editor = page.getByRole('form', { name: 'Edit message' })
    await editor.getByRole('textbox', { name: 'Edited reasoning block 1', exact: true }).fill('  Revised plan\n日本語\n')
    // A reasoning-only checkpoint is a useful mid-thought intervention point.
    await editor.getByRole('textbox', { name: 'Edited message', exact: true }).fill('')
    await editor.getByRole('combobox', { name: 'Reasoning replay', exact: true }).selectOption('interleaved')
    await editor.getByRole('button', { name: 'Save as new branch', exact: true }).click()
    await expect(editor).toHaveCount(0)
    const panel = messages.locator('details[aria-label="Response reasoning"]').last()
    await panel.locator('summary').click()
    await expect(panel).toContainText('Interleaved mock · edited')
    await expect(panel).not.toContainText('42 tokens')
    await page.getByRole('textbox', { name: 'Message input', exact: true }).fill('Use the other approach')
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    const preview = page.getByRole('dialog', { name: 'Request preview' })
    const raw = JSON.parse((await preview.locator('pre').first().textContent())!)
    expect(raw.tool_choice).toBe('none')
    expect(JSON.stringify(raw)).not.toContain('Selected reasoning text')
    expect(JSON.stringify(raw)).not.toContain('Original answer')
    if (protocol === 'openai_chat_completions') {
      const checkpoint = raw.messages.find((item: { tool_calls?: unknown }) => item.tool_calls)
      expect(checkpoint.content).toBe('')
      expect(checkpoint.reasoning_content).toBe('  Revised plan\n日本語\n')
      const result = raw.messages.find((item: { role: string }) => item.role === 'tool')
      expect(result.tool_call_id).toBe(checkpoint.tool_calls[0].id)
      expect(result.content.endsWith('Use the other approach')).toBe(true)
      expect(result.content).toContain('deterministic local context content')
      expect(JSON.stringify(raw).split('Use the other approach')).toHaveLength(2)
      expect(raw.messages.at(-1)).toEqual(result)
    } else {
      const checkpoint = raw.input.find((item: { type: string }) => item.type === 'function_call')
      const result = raw.input.find((item: { type: string }) => item.type === 'function_call_output')
      expect(raw.input.find((item: { type: string }) => item.type === 'reasoning').content[0].text).toBe('  Revised plan\n日本語\n')
      expect(result.call_id).toBe(checkpoint.call_id)
      expect(result.output.endsWith('Use the other approach')).toBe(true)
      expect(result.output).toContain('deterministic local context content')
      expect(JSON.stringify(raw).split('Use the other approach')).toHaveLength(2)
      expect(raw.input.at(-1)).toEqual(result)
    }
    await preview.getByRole('button', { name: 'Close', exact: true }).click()
    // The original branch still contains its untouched answer and raw reasoning.
    await messages.getByRole('article', { name: 'Assistant message' }).last().getByRole('button', { name: 'Previous branch', exact: true }).click()
    await expect(original).toBeVisible()
    await original.locator('details[aria-label="Response reasoning"] summary').click()
    await expect(original).toContainText('First plan')
    await expect(original).not.toContainText('Revised plan')
  })
}
