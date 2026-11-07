import type { Page } from '@playwright/test'

export interface MockSseEvent {
  data: Record<string, unknown> | string
  event?: string
}

export interface MockProviderPlan {
  text?: string
  intervalMs?: number
  chunkSize?: number
  events?: MockSseEvent[]
  // Keep the response alive for deterministic cancellation tests.
  holdOpen?: boolean
}

/**
 * Intercepts only explicitly configured *.invalid test endpoints in the page.
 * The real application still compiles and persists its request, calls fetch
 * exactly once, parses ReadableStream SSE and commits the assistant result.
 * No production code or remote network endpoint is modified.
 */
export async function installMockBrowserProvider(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Event = { data: Record<string, unknown> | string; event?: string }
    type Plan = { text?: string; intervalMs?: number; chunkSize?: number; events?: Event[]; holdOpen?: boolean }
    const state = window as typeof window & {
      __cerachatMockProviderPlans?: Plan[]
      __cerachatMockProviderRequests?: { url: string; body: string }[]
    }
    state.__cerachatMockProviderPlans = []
    state.__cerachatMockProviderRequests = []
    const original = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      let parsed: URL
      try { parsed = new URL(url, location.href) } catch { return original(input, init) }
      if (!parsed.hostname.endsWith('.invalid')) return original(input, init)
      state.__cerachatMockProviderRequests?.push({ url: parsed.href, body: String(init?.body ?? '') })

      const plan = state.__cerachatMockProviderPlans?.shift() ?? {}
      const isResponses = parsed.pathname.endsWith('/responses')
      const text = plan.text ?? 'Browser preview simulates streaming locally. The desktop build sends the inspected JSON exactly once to the configured OpenAI-compatible endpoint.'
      const size = plan.chunkSize ?? 12
      const parts = text.match(new RegExp(`[\\s\\S]{1,${Math.max(1, size)}}`, 'g')) ?? []
      const events: Event[] = plan.events ?? parts.map((part) => ({ data: isResponses
        ? { type: 'response.output_text.delta', delta: part }
        : { choices: [{ delta: { content: part } }] },
      }))
      const done: Event = { data: isResponses ? { type: 'response.completed', response: { usage: {} } } : '[DONE]' }
      const encoder = new TextEncoder()
      const signal = init?.signal
      let stopped = false
      let timer: number | undefined
      let abortListener: (() => void) | undefined
      const cleanup = () => {
        stopped = true
        if (timer !== undefined) clearInterval(timer)
        if (abortListener) signal?.removeEventListener('abort', abortListener)
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (event: Event) => {
            const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data)
            const wire = `${event.event ? `event: ${event.event}\n` : ''}data: ${data}\n\n`
            controller.enqueue(encoder.encode(wire))
          }
          abortListener = () => { if (!stopped) { cleanup(); controller.error(new DOMException('Cancelled', 'AbortError')) } }
          signal?.addEventListener('abort', abortListener, { once: true })
          let index = 0
          timer = window.setInterval(() => {
            if (stopped) return
            if (index < events.length) send(events[index++])
            if (index !== events.length || plan.holdOpen) return
            send(done)
            cleanup()
            controller.close()
          }, plan.intervalMs ?? 40)
          if (signal?.aborted) abortListener()
        },
        cancel() { cleanup() },
      })
      return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }))
    }
  })
}

/** Queue one or more response plans in call order, before clicking Send. */
export async function mockNextBrowserResponses(page: Page, ...plans: MockProviderPlan[]): Promise<void> {
  await page.evaluate((incoming) => {
    const state = window as typeof window & { __cerachatMockProviderPlans?: MockProviderPlan[] }
    if (!state.__cerachatMockProviderPlans) throw new Error('Mock provider was not installed before page navigation')
    state.__cerachatMockProviderPlans.push(...incoming)
  }, plans)
}

export async function mockBrowserRequests(page: Page): Promise<{ url: string; body: string }[]> {
  return page.evaluate(() => {
    const state = window as typeof window & { __cerachatMockProviderRequests?: { url: string; body: string }[] }
    return state.__cerachatMockProviderRequests ?? []
  })
}
