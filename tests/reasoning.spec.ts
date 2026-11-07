import { expect, test, type Page } from '@playwright/test'
import {
  installMockBrowserProvider, mockBrowserRequests, mockNextBrowserResponses,
  type MockProviderPlan, type MockSseEvent,
} from './helpers/browser-provider'

async function openWithStream(page: Page, protocol: 'openai_responses' | 'openai_chat_completions' = 'openai_responses') {
  await installMockBrowserProvider(page)
  await page.addInitScript((protocol) => {
    if (!localStorage.getItem('cerachat.provider-catalog.v1')) localStorage.setItem('cerachat.provider-catalog.v1', JSON.stringify({
      version: 2,
      settings: {
        providers: [{ id: 'local', name: 'Local', protocol, base_url: 'https://unused.invalid/v1', api_key_storage: 'plain_portable', system_text: '', context_separator: '\n---\n' }],
        models: [{ provider_id: 'local', model_id: 'test', name: 'Test', context_window: 128000, max_output_tokens: 1024, temperature: null, raw_json_overrides: '{"reasoning":{"effort":"high"},"store":false}' }],
        selected_model_id: 'local::test',
      },
      secrets: { api_keys: { local: '' } },
    }))
  }, protocol)
  await page.goto('/')
  await expect(page.getByRole('main').getByRole('button', { name: 'Test' }).first()).toBeVisible()
}

async function sendMockAnswer(page: Page, prompt: string, answer: string, plan: MockProviderPlan): Promise<void> {
  await mockNextBrowserResponses(page, plan)
  await page.getByRole('textbox', { name: 'Message input', exact: true }).fill(prompt)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByText(answer, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(0)
}

function reasoningPlan(protocol: 'openai_responses' | 'openai_chat_completions', answer: string, raw: string, summary = '', tokens = 42, encrypted = false): MockProviderPlan {
  const events: MockSseEvent[] = protocol === 'openai_responses' ? [
    ...(summary ? [{ data: { type: 'response.reasoning_summary_text.delta', item_id: 'rs', summary_index: 0, delta: summary } }] : []),
    ...(raw ? [{ data: { type: 'response.reasoning_text.delta', item_id: 'rs', content_index: 0, delta: raw } }] : []),
    { data: { type: 'response.output_text.delta', delta: answer } },
    { data: { type: 'response.completed', response: {
      output: [{ id: 'rs', type: 'reasoning', ...(encrypted ? { encrypted_content: 'opaque-ciphertext' } : {}) }],
      usage: { output_tokens_details: { reasoning_tokens: tokens } },
    } } },
  ] : [
    ...(raw ? [{ data: { choices: [{ delta: { reasoning_content: raw } }] } }] : []),
    ...(summary ? [{ data: { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.summary', index: 0, summary }, ...(encrypted ? [{ type: 'reasoning.encrypted' }] : [])] } }] } }] : []),
    { data: { choices: [{ delta: { content: answer } }] } },
    { data: { choices: [], usage: { completion_tokens_details: { reasoning_tokens: tokens } } } },
  ]
  return { events }
}

test('streams, folds, saves and restores reasoning separately from the answer and next request', async ({ page }) => {
  await openWithStream(page)
  await page.clock.install()
  await page.clock.pauseAt(new Date())
  await mockNextBrowserResponses(page, { events: [
    { data: { type: 'response.reasoning_summary_text.delta', item_id: 'rs', summary_index: 0, delta: 'Summary 日本語' } },
    { data: { type: 'response.reasoning_summary_text.delta', item_id: 'rs', summary_index: 0, delta: ' continued' } },
    { data: { type: 'response.reasoning_text.delta', item_id: 'rs', content_index: 0, delta: 'Provider steps' } },
    { data: { type: 'response.output_text.delta', delta: 'Visible answer' } },
    { data: { type: 'response.completed', response: { output: [{ type: 'reasoning', id: 'rs', encrypted_content: 'opaque-ciphertext' }], usage: { output_tokens_details: { reasoning_tokens: 123 } } } } },
  ] })
  await page.getByRole('textbox', { name: 'Message input', exact: true }).fill('Reasoning question')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeEnabled()
  await page.clock.runFor(40)
  const messages = page.getByRole('region', { name: 'Conversation messages' })
  const panel = messages.locator('details[aria-label="Response reasoning"]').last()
  await expect(panel.locator('summary')).toHaveText('Reasoning summary')
  await expect(panel).not.toHaveAttribute('open', '')
  await panel.locator('summary').click()
  await expect(panel).toContainText('Summary 日本語')
  await expect(panel.getByRole('checkbox')).toBeDisabled()
  await expect(panel.getByRole('checkbox')).not.toBeChecked()
  await page.clock.runFor(160)
  await expect(panel).toContainText('Summary 日本語 continued')
  await expect(panel).toContainText('Provider steps')
  await expect(panel.locator('summary')).toHaveText('Reasoning 123 tokens')
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(0)
  await expect(messages.getByText('Visible answer', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Large log review', exact: true }).click()
  await page.getByRole('button', { name: 'Deterministic request architecture', exact: true }).click()
  await messages.locator('details[aria-label="Response reasoning"] summary').click()
  await expect(messages.locator('details[aria-label="Response reasoning"]')).toContainText('Summary 日本語 continued')
  await expect(messages.locator('details[aria-label="Response reasoning"]')).toContainText('protected reasoning')
  // Native Responses raw reasoning is replayable by default. Uncheck it to
  // verify the history preview excludes unselected reasoning and the summary.
  const rawIncluded = messages.locator('details[aria-label="Response reasoning"]').getByRole('checkbox', { name: 'Include reasoning text in next request' })
  await rawIncluded.click()
  await expect(rawIncluded).not.toBeChecked()
  await page.getByRole('textbox', { name: 'Message input', exact: true }).fill('Next question')
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  const preview = page.getByRole('dialog', { name: 'Request preview' }).locator('pre').first()
  await expect(preview).toContainText('Visible answer')
  await expect(preview).not.toContainText('Provider steps')
  await expect(preview).not.toContainText('Summary 日本語')
})

test('includes checked reasoning blocks in previews and the next send, and remembers choices per message', async ({ page }) => {
  await openWithStream(page)
  await sendMockAnswer(page, 'Manual reasoning question', 'Manual answer', reasoningPlan(
    'openai_responses', 'Manual answer', 'Optional reasoning steps', 'Selected summary 日本語', 99, true,
  ))
  const messages = page.getByRole('region', { name: 'Conversation messages' })
  const panel = messages.locator('details[aria-label="Response reasoning"]').last()
  await panel.locator('summary').click()
  const summary = panel.getByRole('checkbox', { name: 'Include reasoning summary in next request' })
  const text = panel.getByRole('checkbox', { name: 'Include reasoning text in next request' })
  await expect(summary).not.toBeChecked()
  // Unlike the former artificial fixture, a native Responses text part defaults
  // to selected, so explicitly turn it off before testing opt-in behavior.
  await expect(text).toBeChecked()
  await text.click()
  await expect(text).not.toBeChecked()
  await summary.click()
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

  await summary.click()
  await expect(summary).not.toBeChecked()
  await text.click()
  await expect(text).toBeEnabled()
  await mockNextBrowserResponses(page, { text: 'Follow-up answer' })
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => (await mockBrowserRequests(page)).at(-1)?.body ?? '').toContain('Optional reasoning steps')
  const sent = (await mockBrowserRequests(page)).at(-1)!.body
  expect(sent).not.toContain('Selected summary 日本語')
  expect(sent).not.toContain('[Selected reasoning text]')
  expect(JSON.parse(sent).input.some((item: { type?: string; content?: { type: string; text: string }[] }) => item.type === 'reasoning' && item.content?.[0].text === 'Optional reasoning steps')).toBe(true)
  await expect(messages.getByText('Follow-up answer', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(0)
})

test('explains usage-only reasoning and leaves ordinary answers uncluttered', async ({ page }) => {
  await openWithStream(page, 'openai_chat_completions')
  const messages = page.getByRole('region', { name: 'Conversation messages' })
  await expect(messages.locator('details[aria-label="Response reasoning"]')).toHaveCount(0)
  await page.clock.install()
  await page.clock.pauseAt(new Date())
  await mockNextBrowserResponses(page, { holdOpen: true, events: [
    { data: { choices: [], usage: { completion_tokens_details: { reasoning_tokens: 456 } } } },
  ] })
  await page.getByRole('textbox', { name: 'Message input', exact: true }).fill('Reasoning token usage only')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeEnabled()
  await page.clock.runFor(40)
  const panel = messages.locator('details[aria-label="Response reasoning"]')
  await expect(panel.locator('summary')).toContainText('456 tokens')
  await panel.locator('summary').click()
  await expect(panel).toContainText('did not return visible reasoning text')
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
})

test('streaming follows the bottom, preserves a reader scrolling up, and offers a jump back', async ({ page }) => {
  await openWithStream(page)
  await page.clock.install()
  await page.clock.pauseAt(new Date())
  const messages = page.getByRole('region', { name: 'Conversation messages' })
  const jump = page.getByRole('button', { name: 'Scroll to latest message' })
  const bottomGap = () => messages.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)
  await mockNextBrowserResponses(page, { holdOpen: true, events: [
    { data: { type: 'response.output_text.delta', delta: 'A long response\n\n'.repeat(80) } },
    { data: { type: 'response.output_text.delta', delta: 'More response\n\n'.repeat(40) } },
    { data: { type: 'response.output_text.delta', delta: 'The final section\n\n'.repeat(20) } },
  ] })
  await page.getByRole('textbox', { name: 'Message input', exact: true }).fill('Long stream')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeEnabled()
  await page.clock.runFor(40)
  await expect.poll(bottomGap).toBeLessThan(48)
  await expect(jump).toHaveCount(0)
  await messages.hover()
  await page.mouse.wheel(0, -700)
  await expect(jump).toBeVisible()
  const readingPosition = await messages.evaluate((element) => element.scrollTop)
  await page.clock.runFor(40)
  await expect.poll(() => messages.evaluate((element) => element.scrollTop)).toBe(readingPosition)
  await jump.click()
  await expect.poll(bottomGap).toBeLessThan(48)
  await expect(jump).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Message input', exact: true })).toBeFocused()
  await page.clock.runFor(40)
  await expect.poll(bottomGap).toBeLessThan(48)
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
})

test('summary setting preserves other overrides, survives reload, and appears in request preview', async ({ page }) => {
  await openWithStream(page)
  const external: string[] = []
  page.on('request', (req) => { if (!req.url().startsWith('http://127.0.0.1:4173/')) external.push(req.url()) })
  await page.getByRole('main').getByRole('button', { name: 'Provider settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Provider settings' })
  await settings.getByRole('button', { name: 'Test test', exact: true }).click()
  await settings.getByRole('tab', { name: 'Request parameters', exact: true }).click()
  await settings.getByRole('switch', { name: 'Enable Reasoning summary', exact: true }).click()
  await settings.getByLabel('Reasoning summary', { exact: true }).fill('auto')
  expect(JSON.parse(await settings.getByLabel('Raw JSON overrides').inputValue())).toEqual({ reasoning: { effort: 'high', summary: 'auto' }, store: false })
  await settings.getByRole('button', { name: 'Save model', exact: true }).click()
  await settings.getByRole('button', { name: 'Done', exact: true }).click()
  await page.reload()
  await page.getByRole('main').getByRole('button', { name: 'Provider settings', exact: true }).click()
  await settings.getByRole('button', { name: 'Test test', exact: true }).click()
  await settings.getByRole('tab', { name: 'Request parameters', exact: true }).click()
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
    await sendMockAnswer(page, 'Work on the draft', 'Original answer', reasoningPlan(protocol, 'Original answer', '  First plan\n日本語\n'))
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
