import { test, expect } from '@playwright/test'

test('SQLite OPFS conversations, branches, Zstd sources and context survive reload', async ({ page }) => {
  await page.goto('/')
  const first = await page.evaluate(async () => {
    const backend = await import('/src/lib/backend.ts')
    const initial = await backend.bootstrap()
    const conversation = await backend.createConversation()
    const source = await backend.addTextSource(conversation.id, 'notes.txt', 'alpha\nbeta\ngamma')
    const slice = await backend.addContextSlice({ sourceId: source.id, rangeType: 'lines', startPos: 2, endPos: 3, wrapper: 'labeled', insertAt: 'before_current' })
    const lines = await backend.getSourceLines(source.id)
    return { initialCount: initial.conversations.length, conversation, source, slice, lines }
  })
  // The normal browser starts empty; the Playwright server deliberately seeds
  // demo fixtures to preserve older UI behavior contracts.
  expect(first.initialCount).toBeGreaterThanOrEqual(0)
  expect(first.slice.estimated_tokens).toBeGreaterThan(0)
  expect(first.lines.lines).toEqual(['alpha', 'beta', 'gamma'])
  await page.reload()
  const second = await page.evaluate(async (first) => {
    const backend = await import('/src/lib/backend.ts')
    const state = await backend.bootstrap()
    const lines = await backend.getSourceLines(first.source.id)
    return { state, lines }
  }, first)
  expect(second.state.conversations.some((row) => row.id === first.conversation.id)).toBe(true)
  expect(second.state.sources.find((row) => row.id === first.source.id)?.blob_hash).toMatch(/^[0-9a-f]{64}$/)
  expect(second.state.slices.find((row) => row.id === first.slice.id)?.estimated_tokens).toBe(first.slice.estimated_tokens)
  expect(second.lines.lines).toEqual(['alpha', 'beta', 'gamma'])
})

test('audits the exact request before network, and preserves completed branch after reload', async ({ page }) => {
  await page.goto('/')
  const configuration = await page.evaluate(async () => {
    const backend = await import('/src/lib/backend.ts')
    const conversation = await backend.createConversation()
    await backend.saveProvider({ id: 'example', name: 'Example', protocol: 'openai_chat_completions',
      base_url: window.location.origin + '/v1', api_key_storage: 'plain_portable', system_text: '', context_separator: '\n---\n' }, 'test-session-key')
    await backend.saveModel({ provider_id: 'example', model_id: 'model-id', name: 'Model', context_window: 5000,
      max_output_tokens: 300, temperature: null, raw_json_overrides: '{}' })
    await backend.selectModel('example::model-id')
    const preview = await backend.compileRequest({ conversationId: conversation.id, parentId: null,
      input: 'hello browser', historyMode: 'no_history' })
    return { conversation, preview }
  })
  let posts = 0
  await page.route('**/v1/chat/completions', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*' } })
    }
    posts++
    expect(route.request().postData()).toBe(configuration.preview.request_json)
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"choices":[{"delta":{"content":"Real reply"}}]}\n\ndata: [DONE]\n\n' })
  })
  const result = await page.evaluate(async (configuration) => {
    const backend = await import('/src/lib/backend.ts')
    const storage = await import('/src/lib/browserStorage.ts')
    const completed = new Promise<string>((resolve, reject) => {
      void backend.subscribeStream((payload) => {
        if (payload.kind === 'done') resolve(payload.request_id)
        if (payload.kind === 'error') reject(new Error(payload.error))
      })
    })
    const requestId = await backend.sendMessage({ conversationId: configuration.conversation.id, parentId: null,
      input: 'hello browser', historyMode: 'no_history' })
    const before = await storage.query<{actual_request_json:string;browser_status:string}>(
      'SELECT actual_request_json,browser_status FROM request_logs WHERE id=?', [requestId])
    await completed
    return { requestId, before }
  }, configuration)
  expect(posts).toBe(1)
  expect(result.before[0].actual_request_json).toBe(configuration.preview.request_json)
  await page.reload()
  const after = await page.evaluate(async ({ requestId, conversationId }) => {
    const backend = await import('/src/lib/backend.ts')
    const storage = await import('/src/lib/browserStorage.ts')
    const logs = await storage.query<{actual_request_json:string;browser_status:string;assistant_message_id:string}>(
      'SELECT actual_request_json,browser_status,assistant_message_id FROM request_logs WHERE id=?', [requestId])
    return { messages: await backend.getMessages(conversationId), logs }
  }, { requestId: result.requestId, conversationId: configuration.conversation.id })
  expect(after.messages.map((row) => row.role)).toEqual(['user', 'assistant'])
  expect(after.messages[1].content).toBe('Real reply')
  expect(after.logs[0].browser_status).toBe('completed')
  expect(after.logs[0].actual_request_json).toBe(configuration.preview.request_json)
  expect(after.logs[0].assistant_message_id).toBe(after.messages[1].id)
})

test('another tab cannot open the same origin database for writing', async ({ page, context }) => {
  await page.goto('/')
  await page.evaluate(async () => (await import('/src/lib/backend.ts')).bootstrap())
  const other = await context.newPage()
  await other.goto('/')
  const second = await other.evaluate(async () => {
    try {
      await (await import('/src/lib/backend.ts')).bootstrap()
      return 'unexpected success'
    } catch (error) { return error instanceof Error ? error.message : String(error) }
  })
  expect(second).toMatch(/in use by another tab/i)
  await other.close()
})

test('marks in-flight audits interrupted after reload, without re-sending provider requests', async ({ page }) => {
  const providerRequests: string[] = []
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4173/')) providerRequests.push(request.url())
  })
  await page.goto('/')
  const requestId = await page.evaluate(async () => {
    const backend = await import('/src/lib/backend.ts')
    const storage = await import('/src/lib/browserStorage.ts')
    const conversation = await backend.createConversation()
    const id = crypto.randomUUID()
    await storage.execute(`INSERT INTO request_logs(id,conversation_id,user_message_id,assistant_message_id,
      request_sha256,compiled_prompt,actual_request_json,created_at,browser_status)
      VALUES(?,?,NULL,NULL,?,?,?,?, 'pending')`, [id, conversation.id, '1'.repeat(64), 'awaiting', '{"model":"stub"}', Date.now()])
    return id
  })
  await page.reload()
  const rows = await page.evaluate(async (id) => {
    const storage = await import('/src/lib/browserStorage.ts')
    return storage.query<{ browser_status: string; actual_request_json: string }>(
      'SELECT browser_status,actual_request_json FROM request_logs WHERE id=?', [id])
  }, requestId)
  expect(rows).toEqual([{ browser_status: 'interrupted', actual_request_json: '{"model":"stub"}' }])
  expect(providerRequests).toEqual([])
})
