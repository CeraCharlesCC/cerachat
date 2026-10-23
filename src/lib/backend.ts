import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { demoBootstrap, demoMessages, demoSourceLines } from './demo'
import { estimateTokens } from './utils'
import { makeUniqueModelId, resolveProviderConfig, validateModel, validateProvider, validateProviderCatalog } from './catalog'
import type {
  AddSliceArgs,
  BootstrapState,
  CompileRequestArgs,
  ContextSlice,
  Conversation,
  Message,
  ModelProfile,
  ProviderCatalog,
  ProviderConfig,
  ProviderProfile,
  RegenerateArgs,
  RequestPreview,
  SourceLines,
  StreamPayload,
  UniqueModelId,
  UpdateSliceArgs,
  WorkspaceSource,
} from '../types'

export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const browserBootstrap: BootstrapState = structuredClone(demoBootstrap)
let browserMessages: Message[] = structuredClone(demoMessages)
const browserListeners = new Set<(payload: StreamPayload) => void>()

export const BROWSER_PROVIDER_STORAGE_KEY = 'cerachat.provider-catalog.v1'

interface BrowserProviderEnvelope {
  version: 1
  settings: ProviderCatalog
  secrets: { api_keys: Record<string, string> }
}

const emptyCatalog = (): ProviderCatalog => ({ providers: [], models: [], selected_model_id: null })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
}

function validateBrowserEnvelope(value: unknown): asserts value is BrowserProviderEnvelope {
  if (!isRecord(value) || !exactKeys(value, ['version', 'settings', 'secrets']) || value.version !== 1) {
    throw new Error('Browser provider settings use an unsupported or invalid schema')
  }
  validateProviderCatalog(value.settings)
  if (!isRecord(value.secrets) || !exactKeys(value.secrets, ['api_keys']) || !isRecord(value.secrets.api_keys)) {
    throw new Error('Browser provider secrets have an invalid shape')
  }
  const providerIds = new Set(value.settings.providers.map((provider) => provider.id))
  const secretIds = Object.keys(value.secrets.api_keys)
  if (secretIds.length !== providerIds.size) throw new Error('Every provider must have exactly one API key entry')
  for (const [providerId, apiKey] of Object.entries(value.secrets.api_keys)) {
    if (!providerIds.has(providerId)) throw new Error(`API key belongs to unknown provider "${providerId}"`)
    if (typeof apiKey !== 'string') throw new Error(`API key for provider "${providerId}" must be a string`)
  }
}

function readBrowserEnvelope(): BrowserProviderEnvelope {
  const stored = localStorage.getItem(BROWSER_PROVIDER_STORAGE_KEY)
  if (stored === null) return { version: 1, settings: emptyCatalog(), secrets: { api_keys: {} } }
  let value: unknown
  try {
    value = JSON.parse(stored)
  } catch {
    throw new Error('Browser provider settings contain malformed JSON; clear them and configure the catalog again')
  }
  try {
    validateBrowserEnvelope(value)
  } catch (reason) {
    throw new Error(`Browser provider settings are invalid: ${reason instanceof Error ? reason.message : String(reason)}. Clear this site's stored data and configure the catalog again.`)
  }
  return structuredClone(value)
}

function writeBrowserEnvelope(envelope: BrowserProviderEnvelope): ProviderCatalog {
  validateBrowserEnvelope(envelope)
  localStorage.setItem(BROWSER_PROVIDER_STORAGE_KEY, JSON.stringify(envelope))
  return structuredClone(envelope.settings)
}

function activeBrowserProvider(): ProviderConfig {
  const envelope = readBrowserEnvelope()
  const selected = envelope.settings.selected_model_id
  const providerId = selected?.split('::')[0]
  if (!providerId) return resolveProviderConfig(envelope.settings, '')
  const apiKey = envelope.secrets.api_keys[providerId]
  if (apiKey === undefined) throw new Error(`API key entry for provider "${providerId}" is missing`)
  return resolveProviderConfig(envelope.settings, apiKey)
}

async function call<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error('Desktop bridge is unavailable in browser preview')
  return invoke<T>(name, args)
}

export async function bootstrap(): Promise<BootstrapState> {
  if (!isTauri()) return { ...structuredClone(browserBootstrap), provider_catalog: readBrowserEnvelope().settings }
  return call<BootstrapState>('bootstrap')
}

export async function getMessages(conversationId: string): Promise<Message[]> {
  if (!isTauri()) return structuredClone(browserMessages.filter((message) => message.conversation_id === conversationId))
  return call<Message[]>('get_messages', { conversationId })
}

export async function createConversation(): Promise<Conversation> {
  if (!isTauri()) {
    const now = Date.now()
    const conversation = { id: crypto.randomUUID(), title: 'New chat', created_at: now, updated_at: now }
    browserBootstrap.conversations.unshift(conversation)
    return structuredClone(conversation)
  }
  return call<Conversation>('create_conversation')
}

export async function deleteConversation(conversationId: string): Promise<void> {
  if (!isTauri()) {
    browserBootstrap.conversations = browserBootstrap.conversations.filter((item) => item.id !== conversationId)
    browserMessages = browserMessages.filter((message) => message.conversation_id !== conversationId)
    const removed = new Set(browserBootstrap.sources.filter((source) => source.conversation_id === conversationId).map((source) => source.id))
    browserBootstrap.sources = browserBootstrap.sources.filter((source) => !removed.has(source.id))
    browserBootstrap.slices = browserBootstrap.slices.filter((slice) => !removed.has(slice.source_id))
    for (const id of removed) browserSourceTexts.delete(id)
    return
  }
  await call('delete_conversation', { conversationId })
}

export async function setMessageIncluded(messageId: string, included: boolean): Promise<void> {
  if (!isTauri()) {
    const message = browserMessages.find((item) => item.id === messageId)
    if (message) message.include_next = included
    return
  }
  await call('set_message_included', { messageId, included })
}

export async function deleteBranch(messageId: string): Promise<void> {
  if (!isTauri()) {
    const ids = new Set([messageId])
    let changed = true
    while (changed) {
      changed = false
      for (const message of browserMessages) {
        if (message.parent_id && ids.has(message.parent_id) && !ids.has(message.id)) {
          ids.add(message.id)
          changed = true
        }
      }
    }
    browserMessages = browserMessages.filter((message) => !ids.has(message.id))
    return
  }
  await call('delete_branch', { messageId })
}

export async function editMessage(messageId: string, content: string): Promise<Message> {
  if (isTauri()) return call<Message>('edit_message', { messageId, content })
  const original = browserMessages.find((message) => message.id === messageId)
  if (!original) throw new Error('Message not found')
  if (!content.trim()) throw new Error('Message content cannot be empty')
  if (original.content === content) return structuredClone(original)
  const edited = { ...original, id: crypto.randomUUID(), content, reasoning: null, created_at: Date.now() }
  browserMessages.push(edited)
  return structuredClone(edited)
}

const browserSourceTexts = new Map<string, string>()

function sourceText(sourceId: string): string {
  const stored = browserSourceTexts.get(sourceId)
  if (stored !== undefined) return stored
  const source = browserBootstrap.sources.find((item) => item.id === sourceId)
  if (!source) throw new Error('Source not found')
  return demoSourceLines(sourceId, 1, source.line_count).lines.join('\n')
}

function sliceText(args: AddSliceArgs): string {
  const text = sourceText(args.sourceId)
  if (args.rangeType === 'all') return text
  const units = args.rangeType === 'lines' ? text.split('\n') : Array.from(text)
  const offset = args.rangeType === 'lines' ? 1 : 0
  const start = args.startPos ?? offset
  const end = args.endPos ?? (args.rangeType === 'lines' ? start : units.length)
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < offset || end < start || end > units.length || (offset === 1 && !text)) throw new Error('Range is outside the source')
  return units.slice(start - offset, end).join(offset ? '\n' : '') + (offset && end < units.length ? '\n' : '')
}

export async function addTextSource(conversationId: string, name: string, text: string): Promise<WorkspaceSource> {
  if (isTauri()) return call('add_text_source', { conversationId, name, text })
  requireBrowserConversation(conversationId)
  if (!name.trim() || !text.trim()) throw new Error('A name and text are required')
  const existing = browserBootstrap.sources.find((source) => source.conversation_id === conversationId && source.origin_path === 'pasted-text' && source.display_name === name.trim() && sourceText(source.id) === text)
  if (existing) return structuredClone(existing)
  const source: WorkspaceSource = {
    id: crypto.randomUUID(), conversation_id: conversationId, display_name: name.trim(), origin_path: 'pasted-text', archive_path: null,
    blob_hash: 'browser-text', original_size: new TextEncoder().encode(text).length,
    line_count: text ? text.split('\n').length : 0, created_at: Date.now(),
  }
  browserBootstrap.sources.push(source)
  browserSourceTexts.set(source.id, text)
  return structuredClone(source)
}

export async function reorderContextSlices(conversationId: string, sliceIds: string[]): Promise<void> {
  if (isTauri()) return call('reorder_context_slices', { conversationId, sliceIds })
  const slices = browserConversationSlices(conversationId)
  const ids = new Set(sliceIds)
  if (ids.size !== sliceIds.length || ids.size !== slices.length || slices.some((slice) => !ids.has(slice.id))) throw new Error('Context changed; refresh and try reordering again')
  slices.forEach((slice) => { slice.sort_order = sliceIds.indexOf(slice.id) })
}

export async function importSources(conversationId: string, paths: string[]): Promise<WorkspaceSource[]> {
  if (!isTauri()) throw new Error('File import is available in the desktop app')
  return call<WorkspaceSource[]>('import_sources', { conversationId, paths })
}

function requireBrowserConversation(conversationId: string) {
  if (!browserBootstrap.conversations.some((conversation) => conversation.id === conversationId)) throw new Error('Conversation not found')
}

function browserConversationSlices(conversationId: string): ContextSlice[] {
  const sourceIds = new Set(browserBootstrap.sources.filter((source) => source.conversation_id === conversationId).map((source) => source.id))
  return browserBootstrap.slices.filter((slice) => sourceIds.has(slice.source_id))
}

export async function referenceSource(conversationId: string, sourceId: string): Promise<WorkspaceSource> {
  if (isTauri()) return call('reference_source', { conversationId, sourceId })
  requireBrowserConversation(conversationId)
  const source = browserBootstrap.sources.find((source) => source.id === sourceId)
  if (!source) throw new Error('Source not found')
  const text = sourceText(source.id)
  const existing = browserBootstrap.sources.find((item) => item.conversation_id === conversationId
    && item.display_name === source.display_name && item.origin_path === source.origin_path
    && item.archive_path === source.archive_path && sourceText(item.id) === text)
  if (existing) return structuredClone(existing)
  const referenced = { ...source, id: crypto.randomUUID(), conversation_id: conversationId, created_at: Date.now() }
  browserBootstrap.sources.push(referenced)
  browserSourceTexts.set(referenced.id, text)
  return structuredClone(referenced)
}

export async function removeSource(sourceId: string): Promise<void> {
  if (!isTauri()) {
    browserSourceTexts.delete(sourceId)
    browserBootstrap.sources = browserBootstrap.sources.filter((source) => source.id !== sourceId)
    browserBootstrap.slices = browserBootstrap.slices.filter((slice) => slice.source_id !== sourceId)
    return
  }
  await call('remove_source', { sourceId })
}

export async function getSourceLines(sourceId: string, startLine = 1, count = 200): Promise<SourceLines> {
  if (!isTauri()) {
    const text = sourceText(sourceId)
    const lines = text ? text.split('\n') : []
    const start = Math.max(1, startLine)
    return { source_id: sourceId, start_line: start, total_lines: lines.length, lines: lines.slice(start - 1, start - 1 + Math.min(500, count)) }
  }
  return call<SourceLines>('get_source_lines', { sourceId, startLine, count })
}

export async function addContextSlice(args: AddSliceArgs): Promise<ContextSlice> {
  if (!isTauri()) {
    const source = browserBootstrap.sources.find((item) => item.id === args.sourceId)
    if (!source) throw new Error('Source not found')
    const selected = sliceText(args)
    const startPos = args.rangeType === 'all' ? null : args.startPos ?? null
    const endPos = args.rangeType === 'all' ? null : args.endPos ?? null
    const existing = browserBootstrap.slices.find((slice) => slice.source_id === args.sourceId && slice.range_type === args.rangeType && slice.start_pos === startPos && slice.end_pos === endPos)
    if (existing) {
      Object.assign(existing, { enabled: true, wrapper: args.wrapper, insert_at: args.insertAt })
      return structuredClone(existing)
    }
    const slice: ContextSlice = {
      id: crypto.randomUUID(),
      source_id: source.id,
      source_name: source.display_name,
      range_type: args.rangeType,
      start_pos: startPos,
      end_pos: endPos,
      enabled: true,
      sort_order: Math.max(-1, ...browserBootstrap.slices.map((slice) => slice.sort_order)) + 1,
      wrapper: args.wrapper,
      insert_at: args.insertAt,
      estimated_tokens: estimateTokens(selected),
    }
    browserBootstrap.slices.push(slice)
    return structuredClone(slice)
  }
  return call<ContextSlice>('add_context_slice', { args })
}

export async function updateContextSlice(args: UpdateSliceArgs): Promise<void> {
  if (!isTauri()) {
    const slice = browserBootstrap.slices.find((item) => item.id === args.sliceId)
    if (slice) {
      if (args.enabled !== undefined) slice.enabled = args.enabled
      if (args.wrapper !== undefined) slice.wrapper = args.wrapper
      if (args.insertAt !== undefined) slice.insert_at = args.insertAt
      if (args.sortOrder !== undefined) slice.sort_order = args.sortOrder
    }
    return
  }
  await call('update_context_slice', { args })
}

export async function deleteContextSlice(sliceId: string): Promise<void> {
  if (!isTauri()) {
    browserBootstrap.slices = browserBootstrap.slices.filter((slice) => slice.id !== sliceId)
    return
  }
  await call('delete_context_slice', { sliceId })
}

export async function saveProvider(provider: ProviderProfile, apiKey: string | null): Promise<ProviderCatalog> {
  if (!isTauri()) {
    validateProvider(provider)
    const envelope = readBrowserEnvelope()
    const index = envelope.settings.providers.findIndex((item) => item.id === provider.id)
    if (index < 0) envelope.settings.providers.push(structuredClone(provider))
    else envelope.settings.providers[index] = structuredClone(provider)
    const previousApiKey = Object.prototype.hasOwnProperty.call(envelope.secrets.api_keys, provider.id)
      ? envelope.secrets.api_keys[provider.id]
      : ''
    const nextApiKey = apiKey ?? previousApiKey
    envelope.secrets.api_keys = { ...envelope.secrets.api_keys, [provider.id]: nextApiKey }
    return writeBrowserEnvelope(envelope)
  }
  return call<ProviderCatalog>('save_provider', { provider, apiKey })
}

export async function deleteProvider(providerId: string): Promise<ProviderCatalog> {
  if (!isTauri()) {
    const envelope = readBrowserEnvelope()
    if (!envelope.settings.providers.some((provider) => provider.id === providerId)) throw new Error(`Provider "${providerId}" does not exist`)
    envelope.settings.providers = envelope.settings.providers.filter((provider) => provider.id !== providerId)
    envelope.settings.models = envelope.settings.models.filter((model) => model.provider_id !== providerId)
    if (envelope.settings.selected_model_id?.startsWith(`${providerId}::`)) envelope.settings.selected_model_id = null
    delete envelope.secrets.api_keys[providerId]
    return writeBrowserEnvelope(envelope)
  }
  return call<ProviderCatalog>('delete_provider', { providerId })
}

export async function saveModel(model: ModelProfile): Promise<ProviderCatalog> {
  if (!isTauri()) {
    validateModel(model)
    const envelope = readBrowserEnvelope()
    if (!envelope.settings.providers.some((provider) => provider.id === model.provider_id)) {
      throw new Error(`Provider "${model.provider_id}" does not exist`)
    }
    const index = envelope.settings.models.findIndex((item) => item.provider_id === model.provider_id && item.model_id === model.model_id)
    if (index < 0) envelope.settings.models.push(structuredClone(model))
    else envelope.settings.models[index] = structuredClone(model)
    return writeBrowserEnvelope(envelope)
  }
  return call<ProviderCatalog>('save_model', { model })
}

export async function deleteModel(providerId: string, modelId: string): Promise<ProviderCatalog> {
  if (!isTauri()) {
    const envelope = readBrowserEnvelope()
    const uniqueId = makeUniqueModelId(providerId, modelId)
    if (!envelope.settings.models.some((model) => model.provider_id === providerId && model.model_id === modelId)) {
      throw new Error(`Model "${uniqueId}" does not exist`)
    }
    envelope.settings.models = envelope.settings.models.filter((model) => model.provider_id !== providerId || model.model_id !== modelId)
    if (envelope.settings.selected_model_id === uniqueId) envelope.settings.selected_model_id = null
    return writeBrowserEnvelope(envelope)
  }
  return call<ProviderCatalog>('delete_model', { providerId, modelId })
}

export async function selectModel(uniqueModelId: UniqueModelId): Promise<ProviderCatalog> {
  if (!isTauri()) {
    const envelope = readBrowserEnvelope()
    if (!envelope.settings.models.some((model) => makeUniqueModelId(model.provider_id, model.model_id) === uniqueModelId)) {
      throw new Error(`Model "${uniqueModelId}" does not exist`)
    }
    envelope.settings.selected_model_id = uniqueModelId
    return writeBrowserEnvelope(envelope)
  }
  return call<ProviderCatalog>('select_model', { uniqueModelId })
}

export async function compileRequest(args: CompileRequestArgs): Promise<RequestPreview> {
  if (isTauri()) return call('compile_request', { args })
  const provider = activeBrowserProvider()
  requireBrowserConversation(args.conversationId)
  const history: Message[] = []
  let currentId = args.parentId
  while (currentId) {
    const message = browserMessages.find((item) => item.id === currentId && item.conversation_id === args.conversationId)
    if (!message || history.length > browserMessages.length) throw new Error('Invalid history branch')
    history.unshift(message)
    currentId = message.parent_id
  }
  let selected = history
  if (args.historyMode === 'no_history') selected = []
  if (args.historyMode === 'last10') selected = history.slice(-10)
  if (args.historyMode === 'since_here') {
    const index = history.findIndex((message) => message.id === args.sinceMessageId)
    if (index < 0) throw new Error('Since here message is not on the active branch')
    selected = history.slice(index)
  }
  selected = selected.filter((message) => message.include_next)
  const parts = { before_current: [], inside_current: [], before_history: [], system: [] } as Record<ContextSlice['insert_at'], string[]>
  const join = (values: string[]) => values.filter((value) => value.length > 0).join(provider.context_separator)
  for (const slice of browserConversationSlices(args.conversationId).sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))) {
    if (!slice.enabled) continue
    const text = sliceText({ sourceId: slice.source_id, rangeType: slice.range_type, startPos: slice.start_pos, endPos: slice.end_pos, wrapper: slice.wrapper, insertAt: slice.insert_at })
    const range = slice.range_type === 'lines' ? ` L${slice.start_pos}-${slice.end_pos}` : slice.range_type === 'chars' ? ` chars ${slice.start_pos}-${slice.end_pos}` : ''
    parts[slice.insert_at].push(slice.wrapper === 'labeled' ? `===== FILE: ${slice.source_name}${range} =====\n${text}` : text)
  }
  const system = join([provider.system_text, join(parts.system)])
  const input = join([join(parts.before_current), args.input, join(parts.inside_current)])
  if (!input) throw new Error('Request has no current user content')
  const messages = [
    ...(parts.before_history.length ? [{ role: 'user', content: join(parts.before_history) }] : []),
    ...selected.map(({ role, content }) => ({ role, content })),
    { role: 'user', content: input },
  ]
  const extra: unknown = JSON.parse(provider.raw_json_overrides || '{}')
  if (!isRecord(extra)) throw new Error('Raw JSON overrides must be a JSON object')
  const reserved = new Set(['model', 'messages', 'input', 'instructions', 'stream', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'temperature', 'previous_response_id', 'conversation', 'prompt', 'background', 'tools', 'tool_choice', 'functions', 'function_call', 'functionDeclarations', 'parallel_tool_calls', 'web_search_options', 'mcp', 'plugins'])
  for (const key of Object.keys(extra)) if (reserved.has(key)) throw new Error(`Raw JSON override key '${key}' is reserved; request structure is controlled by CeraChat`)
  const temperature = provider.temperature === null ? {} : { temperature: provider.temperature }
  const request = provider.protocol === 'openai_responses'
    ? { ...extra, ...temperature, model: provider.model, ...(system ? { instructions: system } : {}), input: messages, stream: true, max_output_tokens: provider.max_output_tokens }
    : { ...extra, ...temperature, model: provider.model, messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages], stream: true, max_tokens: provider.max_output_tokens }
  const requestJson = JSON.stringify(request, null, 2)
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(requestJson))
  const historyTokens = selected.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  let workspaceTokens = Object.values(parts).reduce((sum, values) => sum + estimateTokens(join(values)), 0)
  const separatorCount = Number(parts.before_current.some(Boolean) && Boolean(args.input))
    + Number(parts.inside_current.some(Boolean) && (parts.before_current.some(Boolean) || Boolean(args.input)))
    + Number(Boolean(provider.system_text) && parts.system.some(Boolean))
  const systemTokens = estimateTokens(provider.system_text)
  workspaceTokens += separatorCount * estimateTokens(provider.context_separator)
  const inputTokens = estimateTokens(args.input)
  return {
    request_json: requestJson,
    compiled_prompt: [...(system ? [`[system]\n${system}`] : []), ...messages.map((message) => `[${message.role}]\n${message.content}`)].join('\n\n'),
    request_sha256: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(''),
    breakdown: { system_tokens: systemTokens, history_tokens: historyTokens, workspace_tokens: workspaceTokens, input_tokens: inputTokens, estimated_input_tokens: systemTokens + historyTokens + workspaceTokens + inputTokens, configured_context: provider.context_window, max_output_tokens: provider.max_output_tokens },
  }
}

export async function subscribeStream(handler: (payload: StreamPayload) => void): Promise<() => void> {
  if (!isTauri()) {
    browserListeners.add(handler)
    return () => browserListeners.delete(handler)
  }
  return listen<StreamPayload>('chat-stream', (event) => handler(event.payload))
}

function emitBrowser(payload: StreamPayload) {
  for (const listener of browserListeners) listener(payload)
}

export async function sendMessage(args: CompileRequestArgs): Promise<string> {
  if (isTauri()) return call<string>('send_message', { args })

  await compileRequest(args)

  const requestId = crypto.randomUUID()
  const now = Date.now()
  const user: Message = {
    id: crypto.randomUUID(),
    conversation_id: args.conversationId,
    parent_id: args.parentId,
    role: 'user',
    content: args.input,
    include_next: true,
    created_at: now,
  }
  browserMessages.push(user)
  emitBrowser({ request_id: requestId, conversation_id: args.conversationId, kind: 'started', user_message: user })
  const text = 'Browser preview simulates streaming locally. The desktop build sends the inspected JSON exactly once to the configured OpenAI-compatible endpoint.'
  queueMicrotask(() => emitBrowser({ request_id: requestId, conversation_id: args.conversationId, kind: 'delta', text }))
  queueMicrotask(() => {
    const assistant: Message = {
      id: crypto.randomUUID(),
      conversation_id: args.conversationId,
      parent_id: user.id,
      role: 'assistant',
      content: text,
      include_next: true,
      created_at: now + 1,
    }
    browserMessages.push(assistant)
    emitBrowser({ request_id: requestId, conversation_id: args.conversationId, kind: 'done', assistant_message: assistant })
  })
  return requestId
}

export async function regenerateResponse(args: RegenerateArgs): Promise<string> {
  if (isTauri()) return call<string>('regenerate_response', { args })

  activeBrowserProvider()

  const user = browserMessages.find((message) => message.id === args.userMessageId)
  if (!user || user.conversation_id !== args.conversationId || user.role !== 'user') {
    throw new Error('The user message for this response is no longer available')
  }

  await compileRequest({ conversationId: args.conversationId, parentId: user.parent_id, input: user.content, historyMode: args.historyMode, sinceMessageId: args.sinceMessageId })

  const requestId = crypto.randomUUID()
  const now = Date.now()
  emitBrowser({ request_id: requestId, conversation_id: args.conversationId, kind: 'started' })
  const text = 'This is a locally simulated regenerated response. The desktop build reuses the selected user message, sends one new provider request, and stores the result as a sibling branch.'
  queueMicrotask(() => emitBrowser({ request_id: requestId, conversation_id: args.conversationId, kind: 'delta', text }))
  queueMicrotask(() => {
    const assistant: Message = {
      id: crypto.randomUUID(),
      conversation_id: args.conversationId,
      parent_id: user.id,
      role: 'assistant',
      content: text,
      include_next: true,
      created_at: now,
    }
    browserMessages.push(assistant)
    emitBrowser({ request_id: requestId, conversation_id: args.conversationId, kind: 'done', assistant_message: assistant })
  })
  return requestId
}
