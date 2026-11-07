import { expect, test } from '@playwright/test'

test('posts the inspected JSON exactly once and decodes fragmented chat SSE including reasoning', async ({ page }) => {
  await page.goto('/')
  const actual = await page.evaluate(async () => {
    const { streamBrowserProviderRequest } = await import('/src/lib/browserTransport.ts')
    const raw = '{\n  "model": "demo-model",\n  "stream": true\n}'
    const wire = [
      ': keep-alive\r\n',
      'data: {"choices":[{"delta":{"content":"こんにちは","reasoning_content":"思考"}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.summary","index":2,"summary":"Plan"}],"reasoning_content":"do not duplicate"}}]}\r\n\r\n',
      'data: {"choices":[],"usage":{"completion_tokens_details":{"reasoning_tokens":7}}}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ].join('')
    const bytes = new TextEncoder().encode(wire)
    const utf8 = bytes.findIndex((byte) => byte >= 0xe0)
    const cr = bytes.indexOf(13)
    const cuts = [1, utf8 + 1, utf8 + 2, cr + 1, bytes.length - 6].sort((a, b) => a - b)
    const chunks = [...new Set([0, ...cuts, bytes.length])].slice(1).map((end, index, points) => {
      const previous = index === 0 ? 0 : points[index - 1]
      return bytes.slice(previous, end)
    })
    const calls: { url: string; method?: string; body?: string; authorization?: string; credentials?: string; redirect?: string }[] = []
    const original = window.fetch
    window.fetch = async (url, init) => {
      const headers = new Headers(init?.headers)
      calls.push({ url: String(url), method: init?.method, body: String(init?.body), authorization: headers.get('Authorization') ?? undefined, credentials: init?.credentials, redirect: init?.redirect })
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close() },
      }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    try {
      const deltas: unknown[] = []
      const result = await streamBrowserProviderRequest({
        provider: { base_url: 'https://example.test/v1/responses/', protocol: 'openai_chat_completions', api_key: 'session-secret' },
        requestJson: raw, onDelta: (delta) => deltas.push(delta),
      })
      return { raw, calls, deltas, result }
    } finally { window.fetch = original }
  })

  expect(actual.calls).toEqual([{
    url: 'https://example.test/v1/chat/completions', method: 'POST', body: actual.raw,
    authorization: 'Bearer session-secret', credentials: 'omit', redirect: 'error',
  }])
  expect(actual.result).toEqual({
    content: 'こんにちは',
    reasoning: {
      parts: [
        { id: 'chat-reasoning', kind: 'text', text: '思考', include_next: true },
        { id: 'chat-summary-2', kind: 'summary', text: 'Plan', include_next: false },
      ], tokens: 7, encrypted: false,
    },
  })
  expect(actual.deltas).toHaveLength(3)
})

test('Responses SSE merges reasoning .delta/.done and final snapshots without duplicates', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { streamBrowserProviderRequest } = await import('/src/lib/browserTransport.ts')
    const events = [
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs', summary_index: 0, delta: 'Plan' },
      { type: 'response.reasoning_summary_text.done', item_id: 'rs', summary_index: 0, text: 'Plan revised' },
      { type: 'response.reasoning_text.delta', item_id: 'rs', content_index: 0, delta: 'Raw' },
      { type: 'response.output_text.delta', delta: 'Hello ' },
      { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs', summary: [{ text: 'Plan revised' }], content: [{ text: 'Raw notes' }], encrypted_content: 'ciphertext' } },
      { type: 'response.completed', response: { output: [{ type: 'reasoning', id: 'rs', summary: [{ text: 'Plan revised' }], content: [{ text: 'Raw notes' }] }], usage: { output_tokens_details: { reasoning_tokens: 12 } } } },
    ]
    // The event field supplies the Responses event type even when JSON omits it.
    const wire = events.map((event, index) => {
      const data = index === 0 ? { ...event, type: undefined } : event
      return `event: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`
    }).join('')
    const original = window.fetch
    window.fetch = async () => new Response(wire, { headers: { 'Content-Type': 'text/event-stream' } })
    try {
      return await streamBrowserProviderRequest({
        provider: { base_url: 'https://example.test/v1/chat/completions', protocol: 'openai_responses', api_key: '' },
        requestJson: '{"model":"x","stream":true}',
      })
    } finally { window.fetch = original }
  })
  expect(result.content).toBe('Hello ')
  expect(result.reasoning).toEqual({
    parts: [
      { id: 'rs-summary-0', kind: 'summary', text: 'Plan revised', include_next: false },
      { id: 'rs-text-0', kind: 'text', text: 'Raw notes', include_next: true },
    ], tokens: 12, encrypted: true,
  })
})

test('AbortSignal stops an in-flight stream with partial output, without completing or retrying', async ({ page }) => {
  await page.goto('/')
  const actual = await page.evaluate(async () => {
    const { streamBrowserProviderRequest } = await import('/src/lib/browserTransport.ts')
    const controller = new AbortController()
    const original = window.fetch
    const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
    let calls = 0
    window.fetch = async () => {
      calls++
      return new Response(new ReadableStream<Uint8Array>({
        start(stream) { stream.enqueue(bytes) },
      }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    try {
      const fragments: string[] = []
      try {
        await streamBrowserProviderRequest({
          provider: { base_url: 'https://example.test/v1', protocol: 'openai_chat_completions', api_key: '' },
          requestJson: '{}', signal: controller.signal,
          onDelta(delta) { if (delta.text) fragments.push(delta.text); controller.abort() },
        })
        return { name: 'completed', fragments, calls }
      } catch (error) {
        return { name: error instanceof Error ? error.name : 'unknown', fragments, calls }
      }
    } finally { window.fetch = original }
  })
  expect(actual).toEqual({ name: 'AbortError', fragments: ['partial'], calls: 1 })
})

test('reports HTTP, stream, and browser-CORS failures without retrying', async ({ page }) => {
  await page.goto('/')
  const actual = await page.evaluate(async () => {
    const { streamBrowserProviderRequest, browserProviderEndpoint } = await import('/src/lib/browserTransport.ts')
    const original = window.fetch
    const provider = { base_url: 'https://example.test/v1', protocol: 'openai_chat_completions' as const, api_key: '' }
    const messages: string[] = []
    let calls = 0
    const attempt = async () => {
      try { await streamBrowserProviderRequest({ provider, requestJson: '{}' }); messages.push('succeeded') }
      catch (error) { messages.push(error instanceof Error ? error.message : String(error)) }
    }
    try {
      window.fetch = async () => { calls++; return new Response('Bad credentials', { status: 401 }) }
      await attempt()
      window.fetch = async () => { calls++; return new Response('data: {broken-json}\n\n') }
      await attempt()
      window.fetch = async () => { calls++; return new Response('{"not":"SSE"}') }
      await attempt()
      window.fetch = async () => { calls++; throw new TypeError('Failed to fetch') }
      await attempt()
      let rejected = ''
      try { browserProviderEndpoint('https://name:pass@example.test/v1', 'openai_responses') }
      catch (error) { rejected = String(error) }
      return { calls, messages, rejected }
    } finally { window.fetch = original }
  })
  expect(actual.calls).toBe(4)
  expect(actual.messages[0]).toContain('HTTP 401')
  expect(actual.messages[1]).toContain('invalid SSE JSON')
  expect(actual.messages[2]).toContain('not an SSE stream')
  expect(actual.messages[3]).toContain('CORS')
  expect(actual.rejected).toContain('without credentials')
})

test('fetches a real browser URL, exactly once, using the original preview bytes', async ({ page }) => {
  const observed: { method: string; body: string | null; authorization: string | undefined }[] = []
  await page.route('**/mock/v1/chat/completions', async (route) => {
    observed.push({
      method: route.request().method(), body: route.request().postData(),
      authorization: route.request().headers().authorization,
    })
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"choices":[{"delta":{"content":"real fetch"}}]}\n\ndata: [DONE]\n\n' })
  })
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { streamBrowserProviderRequest } = await import('/src/lib/browserTransport.ts')
    return streamBrowserProviderRequest({
      provider: { base_url: `${location.origin}/mock/v1`, protocol: 'openai_chat_completions', api_key: 'one-off' },
      requestJson: '{\n  "stream": true, "model": "x"\n}',
    })
  })
  expect(result).toEqual({ content: 'real fetch', reasoning: null })
  expect(observed).toEqual([{ method: 'POST', body: '{\n  "stream": true, "model": "x"\n}', authorization: 'Bearer one-off' }])
})

test('flushes a final unterminated event and reports Responses failures', async ({ page }) => {
  await page.goto('/')
  const actual = await page.evaluate(async () => {
    const { streamBrowserProviderRequest } = await import('/src/lib/browserTransport.ts')
    const provider = { base_url: 'https://example.test/v1', protocol: 'openai_responses' as const, api_key: '' }
    const original = window.fetch
    try {
      window.fetch = async () => new Response('event: response.output_text.delta\r\ndata: {"delta":"tail"}\r')
      const success = await streamBrowserProviderRequest({ provider, requestJson: '{}' })
      window.fetch = async () => new Response('event: response.failed\ndata: {"response":{"error":{"message":"quota"}}}\n\n')
      let failure = ''
      try { await streamBrowserProviderRequest({ provider, requestJson: '{}' }) }
      catch (error) { failure = String(error) }
      return { success, failure }
    } finally { window.fetch = original }
  })
  expect(actual.success).toEqual({ content: 'tail', reasoning: null })
  expect(actual.failure).toContain('quota')
})
