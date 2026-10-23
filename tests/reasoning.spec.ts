import { expect, test, type Page } from '@playwright/test'
import type { StreamPayload } from '../src/types'

async function openWithStream(page: Page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem('cerachat.provider-catalog.v1')) localStorage.setItem('cerachat.provider-catalog.v1', JSON.stringify({
      version: 1,
      settings: {
        providers: [{ id: 'local', name: 'Local', protocol: 'openai_responses', base_url: 'https://unused.invalid/v1', api_key_storage: 'plain_portable', system_text: '', temperature: null, raw_json_overrides: '{"reasoning":{"effort":"high"},"store":false}', context_separator: '\n---\n' }],
        models: [{ provider_id: 'local', model_id: 'test', name: 'Test', context_window: 128000, max_output_tokens: 1024 }],
        selected_model_id: 'local::test',
      },
      secrets: { api_keys: { local: '' } },
    }))
  })
  // Feed provider events through the same subscription and store used by the app.
  // This hook exists only in the test response, never in production code.
  await page.route('**/src/lib/backend.ts*', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, body: `${await response.text()}\nwindow.__emitReasoning = (payload) => {
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

test('summary setting preserves other overrides, survives reload, and appears in request preview', async ({ page }) => {
  await openWithStream(page)
  const external: string[] = []
  page.on('request', (req) => { if (!req.url().startsWith('http://127.0.0.1:4173/')) external.push(req.url()) })
  await page.getByRole('main').getByRole('button', { name: 'Provider settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Provider settings' })
  await settings.getByLabel('Reasoning summary', { exact: true }).selectOption('auto')
  expect(JSON.parse(await settings.getByLabel('Raw JSON overrides').inputValue())).toEqual({ reasoning: { effort: 'high', summary: 'auto' }, store: false })
  await settings.getByRole('button', { name: 'Save provider', exact: true }).click()
  await settings.getByRole('button', { name: 'Done', exact: true }).click()
  await page.reload()
  await page.getByRole('main').getByRole('button', { name: 'Provider settings', exact: true }).click()
  await expect(settings.getByLabel('Reasoning summary', { exact: true })).toHaveValue('auto')
  await settings.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('textbox', { name: 'Message input', exact: true }).fill('Question')
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  const raw = await page.getByRole('dialog', { name: 'Request preview' }).locator('pre').first().textContent()
  expect(JSON.parse(raw!).reasoning).toEqual({ effort: 'high', summary: 'auto' })
  expect(external).toEqual([])
})
