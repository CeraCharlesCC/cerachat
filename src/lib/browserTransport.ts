import type { ProviderConfig, ProviderProtocol, Reasoning, ReasoningPart } from '../types'
import { mergeReasoning } from './reasoning'

export interface BrowserTransportDelta {
  // Fragments, not snapshots: merge reasoning by part id before displaying it.
  text?: string
  reasoning?: Reasoning
}

export interface BrowserTransportResult {
  content: string
  reasoning: Reasoning | null
}

export interface BrowserTransportOptions {
  provider: Pick<ProviderConfig, 'base_url' | 'protocol' | 'api_key'>
  // Pass RequestPreview.request_json verbatim: no parsing or reserialization here.
  requestJson: string
  signal?: AbortSignal
  onDelta?: (delta: BrowserTransportDelta) => void
}

/**
 * A browser can contact only providers that explicitly allow this site's origin
 * through CORS, including the OPTIONS preflight for JSON/Authorization headers.
 * There is deliberately no retry, CORS workaround, probe, or implicit proxy.
 * Keys must be supplied by the caller, not embedded into shipped site assets.
 */
export function browserProviderEndpoint(baseUrl: string, protocol: ProviderProtocol): string {
  if (protocol !== 'openai_chat_completions' && protocol !== 'openai_responses') {
    throw new Error(`Unsupported provider protocol: ${protocol}`)
  }
  const path = protocol === 'openai_responses' ? 'responses' : 'chat/completions'
  const root = baseUrl.trim().replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses)$/, '')
  let url: URL
  try {
    url = new URL(`${root}/${path}`)
  } catch {
    throw new Error('Provider base URL must be an absolute HTTP(S) URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Provider base URL must be HTTP(S), without credentials, query, or fragment')
  }
  return url.href
}

interface SseEvent { data: string; event: string }

// ReadableStream chunks can split UTF-8 characters, CRLF boundaries and JSON.
// An SSE record is complete only at a blank line, or at end-of-stream.
class SseParser {
  private pending = ''
  private data: string[] = []
  private eventName = ''
  private eventLength = 0

  push(fragment: string): SseEvent[] {
    this.pending += fragment
    const events: SseEvent[] = []
    while (true) {
      const end = this.pending.search(/[\r\n]/)
      if (end < 0) break
      // Do not mistake a CRLF split across chunks for two separate lines.
      if (this.pending[end] === '\r' && end === this.pending.length - 1) break
      const line = this.pending.slice(0, end)
      const separator = this.pending[end] === '\r' && this.pending[end + 1] === '\n' ? 2 : 1
      this.pending = this.pending.slice(end + separator)
      this.line(line, events)
    }
    if (this.pending.length + this.eventLength > 16 * 1024 * 1024) {
      throw new Error('Provider SSE event exceeds the 16 MiB safety limit')
    }
    return events
  }

  finish(): SseEvent[] {
    // A provider may omit the final blank line; flush the last data record.
    return this.push('\n\n')
  }

  private line(line: string, events: SseEvent[]): void {
    if (!line) {
      if (this.data.length) events.push({ data: this.data.join('\n'), event: this.eventName })
      this.data = []
      this.eventName = ''
      this.eventLength = 0
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    const raw = colon < 0 ? '' : line.slice(colon + 1)
    const value = raw.startsWith(' ') ? raw.slice(1) : raw
    if (field === 'data') {
      this.eventLength += value.length
      if (this.eventLength > 16 * 1024 * 1024) {
        throw new Error('Provider SSE event exceeds the 16 MiB safety limit')
      }
      this.data.push(value)
    } else if (field === 'event') {
      this.eventName = value
    }
    // Ignore id and retry: client must never reconnect on its own.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function field(value: unknown, ...path: (string | number)[]): unknown {
  let current = value
  for (const name of path) {
    if (typeof name === 'number') current = Array.isArray(current) ? current[name] : undefined
    else current = isRecord(current) ? current[name] : undefined
  }
  return current
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function providerError(value: unknown): string {
  const message = asString(field(value, 'message'))
  return (message ?? JSON.stringify(value) ?? 'unknown provider error').slice(0, 4096)
}

function parseSseJson(data: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    throw new Error('Provider returned invalid SSE JSON')
  }
  if (!isRecord(value)) throw new Error('Provider SSE data must be a JSON object')
  if (value.error !== undefined && value.error !== null) {
    throw new Error(`Provider stream error: ${providerError(value.error)}`)
  }
  return value
}

function reasoningValue(parts: ReasoningPart[], tokens: number | null, encrypted: boolean): Reasoning | undefined {
  return parts.length || tokens !== null || encrypted ? { parts, tokens, encrypted } : undefined
}

function chatDelta(value: Record<string, unknown>): BrowserTransportDelta {
  const delta = field(value, 'choices', 0, 'delta')
  const text = asString(field(delta, 'content')) ?? asString(field(value, 'choices', 0, 'text'))
  const tokens = tokenCount(field(value, 'usage', 'completion_tokens_details', 'reasoning_tokens'))
  const parts: ReasoningPart[] = []
  let encrypted = false
  const details = field(delta, 'reasoning_details')
  if (Array.isArray(details)) {
    for (const [position, detail] of details.entries()) {
      const type = field(detail, 'type')
      if (type === 'reasoning.encrypted') {
        encrypted = true
        continue
      }
      const kind = type === 'reasoning.summary' ? 'summary' : type === 'reasoning.text' ? 'text' : null
      if (!kind) continue
      const piece = asString(field(detail, kind))
      if (!piece) continue
      const index = tokenCount(field(detail, 'index')) ?? position
      parts.push({ id: `chat-${kind}-${index}`, kind, text: piece, include_next: false })
    }
  }
  // OpenRouter can send the same reasoning in typed details and legacy fields.
  if (!parts.length) {
    const piece = asString(field(delta, 'reasoning_content')) || asString(field(delta, 'reasoning'))
    if (piece) parts.push({ id: 'chat-reasoning', kind: 'text', text: piece, include_next: true })
  }
  const reasoning = reasoningValue(parts, tokens, encrypted)
  return { ...(text !== undefined ? { text } : {}), ...(reasoning ? { reasoning } : {}) }
}

interface DecodedResponse extends BrowserTransportDelta { done?: boolean }

class ResponsesDecoder {
  private seen = new Map<string, string>()

  private part(parts: ReasoningPart[], id: string, kind: 'summary' | 'text', value: unknown, snapshot: boolean): void {
    const text = asString(value)
    if (text === undefined) return
    const previous = this.seen.get(id) ?? ''
    const addition = snapshot ? (text.startsWith(previous) ? text.slice(previous.length) : '') : text
    if (!addition) return
    this.seen.set(id, previous + addition)
    parts.push({ id, kind, text: addition, include_next: kind === 'text' })
  }

  private item(parts: ReasoningPart[], item: unknown, fallbackId: string): boolean {
    if (field(item, 'type') !== 'reasoning') return false
    const itemId = asString(field(item, 'id')) ?? fallbackId
    for (const [fieldName, kind] of [['summary', 'summary'], ['content', 'text']] as const) {
      const entries = field(item, fieldName)
      if (!Array.isArray(entries)) continue
      entries.forEach((entry, index) => this.part(parts, `${itemId}-${kind}-${index}`, kind, field(entry, 'text'), true))
    }
    return Boolean(asString(field(item, 'encrypted_content')))
  }

  decode(value: Record<string, unknown>, eventName: string): DecodedResponse {
    const type = asString(value.type) ?? eventName
    const parts: ReasoningPart[] = []
    let encrypted = false
    let tokens: number | null = null
    let text: string | undefined
    let done = false
    switch (type) {
      case 'error':
        throw new Error(`Provider stream error: ${asString(value.message) ?? 'unknown Responses API error'}`)
      case 'response.failed':
        throw new Error(`Provider stream error: ${asString(field(value, 'response', 'error', 'message')) ?? 'Responses API request failed'}`)
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        text = asString(value.delta)
        break
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.done':
      case 'response.reasoning_text.done': {
        const summary = type.includes('summary')
        const kind = summary ? 'summary' : 'text'
        const snapshot = type.endsWith('.done')
        const index = tokenCount(value[summary ? 'summary_index' : 'content_index']) ?? 0
        const id = asString(value.item_id) ?? String(value.output_index ?? 'null')
        this.part(parts, `${id}-${kind}-${index}`, kind, value[snapshot ? 'text' : 'delta'], snapshot)
        break
      }
      case 'response.output_item.done':
        encrypted = this.item(parts, value.item, String(value.output_index ?? 'null'))
        break
      case 'response.completed':
      case 'response.incomplete': {
        done = true
        tokens = tokenCount(field(value, 'response', 'usage', 'output_tokens_details', 'reasoning_tokens'))
        const items = field(value, 'response', 'output')
        if (Array.isArray(items)) {
          items.forEach((item, index) => { encrypted = this.item(parts, item, String(index)) || encrypted })
        }
        break
      }
    }
    const reasoning = reasoningValue(parts, tokens, encrypted)
    return { ...(text !== undefined ? { text } : {}), ...(reasoning ? { reasoning } : {}), ...(done ? { done } : {}) }
  }
}

function aborted(): DOMException {
  return new DOMException('Provider request was cancelled', 'AbortError')
}

/**
 * Exactly one HTTP POST; completion and cancellation are distinct. Partial
 * output is delivered by onDelta before an AbortError/error is propagated.
 * The caller owns request-audit persistence and all user-visible StreamPayloads.
 */
export async function streamBrowserProviderRequest({ provider, requestJson, signal, onDelta }: BrowserTransportOptions): Promise<BrowserTransportResult> {
  if (signal?.aborted) throw aborted()
  const endpoint = browserProviderEndpoint(provider.base_url, provider.protocol)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (provider.api_key) headers.Authorization = `Bearer ${provider.api_key}`

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST', headers, body: requestJson, signal, mode: 'cors', credentials: 'omit',
      redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    })
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw aborted()
    throw new Error('Browser request failed. Check network access and provider CORS support (including OPTIONS preflight for JSON and Authorization). A compatible endpoint or trusted proxy is required; browsers cannot bypass CORS.')
  }
  if (signal?.aborted) throw aborted()
  if (!response.ok) {
    let errorBody = ''
    try { errorBody = (await response.text()).slice(0, 4096) } catch { /* Body may be unreadable. */ }
    if (signal?.aborted) throw aborted()
    const imageHint = requestJson.includes('"image_url"') && [400, 413, 415, 422].includes(response.status)
      ? ' Image input was included; verify this model\'s image support, format and size before explicitly retrying.' : ''
    throw new Error(`Provider returned HTTP ${response.status}${errorBody ? `: ${errorBody}` : ''}.${imageHint}`)
  }
  if (!response.body) throw new Error('Provider response does not expose a readable SSE stream')

  const reader = response.body.getReader()
  const onAbort = () => { void reader.cancel().catch(() => undefined) }
  signal?.addEventListener('abort', onAbort, { once: true })
  const parser = new SseParser()
  const decoder = new TextDecoder()
  const responses = new ResponsesDecoder()
  const output: BrowserTransportResult = { content: '', reasoning: null }
  let sawEvent = false
  let complete = false

  const processEvents = (events: SseEvent[]): void => {
    for (const event of events) {
      if (signal?.aborted) throw aborted()
      if (!event.data.trim()) continue
      sawEvent = true
      if (event.data.trim() === '[DONE]') { complete = true; break }
      const value = parseSseJson(event.data)
      const delta = provider.protocol === 'openai_responses'
        ? responses.decode(value, event.event) : chatDelta(value)
      if (delta.text) output.content += delta.text
      if (delta.reasoning) output.reasoning = mergeReasoning(output.reasoning, delta.reasoning)
      if (delta.text || delta.reasoning) onDelta?.({ ...(delta.text ? { text: delta.text } : {}), ...(delta.reasoning ? { reasoning: delta.reasoning } : {}) })
      if ('done' in delta && delta.done) { complete = true; break }
    }
  }

  try {
    while (!complete) {
      if (signal?.aborted) throw aborted()
      const { value, done } = await reader.read()
      if (signal?.aborted) throw aborted()
      if (done) break
      processEvents(parser.push(decoder.decode(value, { stream: true })))
    }
    if (!complete) {
      processEvents(parser.push(decoder.decode()))
      processEvents(parser.finish())
    }
    if (signal?.aborted) throw aborted()
    if (!sawEvent) throw new Error('Provider response was not an SSE stream')
    return output
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (complete || signal?.aborted) void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
