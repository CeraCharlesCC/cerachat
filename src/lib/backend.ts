import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import * as browserData from './browserData'
import { estimateTokens } from './utils'
import { auditHistory, historyContent, historyMessage, interleaveHistory, interventionTool, mergeReasoning, wireHistory } from './reasoning'
import { streamBrowserProviderRequest } from './browserTransport'
import { validateImages, MAX_REQUEST_IMAGE_URL_BYTES, IMAGE_INPUT_HELP } from './images'
import { makeUniqueModelId, resolveProviderConfig, validateModel, validateProvider, validateProviderCatalog } from './catalog'
import type {
  AddSliceArgs,
  BootstrapState,
  CompileRequestArgs,
  ContextSlice,
  Conversation,
  Message,
  Reasoning,
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

const browserListeners = new Set<(payload: StreamPayload) => void>()

export const BROWSER_PROVIDER_STORAGE_KEY = 'cerachat.provider-catalog.v1'
export const BROWSER_SESSION_KEYS_STORAGE_KEY = 'cerachat.provider-session-keys.v1'

interface BrowserProviderEnvelope {
  version: 3
  settings: ProviderCatalog
  // Only keys explicitly opted into persistence are stored here.
  secrets: { api_keys: Record<string, string> }
  remembered_provider_ids: string[]
}

interface LegacyBrowserProviderEnvelope {
  version: 2
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

function validateLegacyEnvelope(value: unknown): asserts value is LegacyBrowserProviderEnvelope {
  if (!isRecord(value) || !exactKeys(value, ['version', 'settings', 'secrets']) || value.version !== 2) {
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

function validateBrowserEnvelope(value: unknown): asserts value is BrowserProviderEnvelope {
  if (!isRecord(value) || !exactKeys(value, ['version', 'settings', 'secrets', 'remembered_provider_ids']) || value.version !== 3) {
    throw new Error('Browser provider settings use an unsupported or invalid schema')
  }
  validateProviderCatalog(value.settings)
  if (!isRecord(value.secrets) || !exactKeys(value.secrets, ['api_keys']) || !isRecord(value.secrets.api_keys)) {
    throw new Error('Browser provider secrets have an invalid shape')
  }
  const providerIds = new Set(value.settings.providers.map((provider) => provider.id))
  if (!Array.isArray(value.remembered_provider_ids)
    || value.remembered_provider_ids.some((id: unknown) => typeof id !== 'string' || !providerIds.has(id))
    || new Set(value.remembered_provider_ids).size !== value.remembered_provider_ids.length) {
    throw new Error('Remembered key preferences are invalid')
  }
  if (Object.keys(value.secrets.api_keys).length !== providerIds.size) throw new Error('Every provider must have exactly one stored key entry')
  const remembered = new Set(value.remembered_provider_ids)
  for (const [id, key] of Object.entries(value.secrets.api_keys)) {
    if (!providerIds.has(id) || typeof key !== 'string') throw new Error('Stored API key belongs to an unknown provider or is invalid')
    if (!remembered.has(id) && key !== '') throw new Error('A session-only API key must not be saved to local storage')
  }
}

function upgradeBrowserEnvelope(value: unknown): unknown {
  if (!isRecord(value) || value.version !== 1) return value
  if (!isRecord(value.settings) || !exactKeys(value.settings, ['providers', 'models', 'selected_model_id'])
    || !Array.isArray(value.settings.providers) || !Array.isArray(value.settings.models)) {
    throw new Error('Legacy provider catalog has an invalid shape')
  }
  const parameters = new Map<string, { temperature: unknown; raw_json_overrides: unknown }>()
  const providers = value.settings.providers.map((provider: unknown) => {
    if (!isRecord(provider) || !exactKeys(provider, ['id', 'name', 'protocol', 'base_url', 'api_key_storage', 'system_text', 'temperature', 'raw_json_overrides', 'context_separator'])) {
      throw new Error('Legacy provider has an invalid shape')
    }
    const { temperature, raw_json_overrides, ...profile } = provider
    // Reuse current parameter validation even when this provider has no models.
    validateModel({ provider_id: profile.id, model_id: 'validation', name: '', context_window: 1, max_output_tokens: 1, temperature, raw_json_overrides })
    parameters.set(profile.id as string, { temperature, raw_json_overrides })
    return profile
  })
  const models = value.settings.models.map((model: unknown) => {
    if (!isRecord(model) || !exactKeys(model, ['provider_id', 'model_id', 'name', 'context_window', 'max_output_tokens'])) {
      throw new Error('Legacy model has an invalid shape')
    }
    const inherited = parameters.get(model.provider_id as string)
    if (!inherited) throw new Error('Legacy model references an unknown provider')
    return { ...model, ...inherited }
  })
  return { ...value, version: 2, settings: { ...value.settings, providers, models } }
}

function readBrowserEnvelope(): BrowserProviderEnvelope {
  const stored = localStorage.getItem(BROWSER_PROVIDER_STORAGE_KEY)
  if (stored === null) return { version: 3, settings: emptyCatalog(), secrets: { api_keys: {} }, remembered_provider_ids: [] }
  let value: unknown
  try {
    value = JSON.parse(stored)
  } catch {
    throw new Error('Browser provider settings contain malformed JSON; clear them and configure the catalog again')
  }
  try {
    value = upgradeBrowserEnvelope(value)
    // Read legacy v1/v2 without overwriting it. The next explicit catalog edit
    // upgrades it, *preserving* legacy persisted keys and their lifetime.
    if (isRecord(value) && value.version === 2) {
      validateLegacyEnvelope(value)
      value = { ...value, version: 3, remembered_provider_ids: value.settings.providers.map((provider) => provider.id) }
    }
    validateBrowserEnvelope(value)
  } catch (reason) {
    throw new Error(`Browser provider settings are invalid: ${reason instanceof Error ? reason.message : String(reason)}. Clear this site's stored data and configure the catalog again.`)
  }
  return structuredClone(value)
}

const temporaryBrowserKeys = new Map<string, string>()

function readSessionKeys(): Record<string, string> {
  let stored: string | null
  try { stored = sessionStorage.getItem(BROWSER_SESSION_KEYS_STORAGE_KEY) } catch { return Object.fromEntries(temporaryBrowserKeys) }
  if (stored === null) return Object.fromEntries(temporaryBrowserKeys)
  let decoded: unknown
  try { decoded = JSON.parse(stored) } catch { throw new Error('Browser session API keys contain malformed JSON') }
  if (!isRecord(decoded) || Object.values(decoded).some((value) => typeof value !== 'string')) {
    throw new Error('Browser session API keys have an invalid shape')
  }
  return decoded as Record<string, string>
}

function writeSessionKeys(keys: Record<string, string>) {
  try {
    sessionStorage.setItem(BROWSER_SESSION_KEYS_STORAGE_KEY, JSON.stringify(keys))
    temporaryBrowserKeys.clear()
  } catch {
    // Restricted/private storage can still use a tab-scoped in-memory secret.
    temporaryBrowserKeys.clear()
    for (const [id, key] of Object.entries(keys)) temporaryBrowserKeys.set(id, key)
  }
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
  const apiKey = envelope.remembered_provider_ids.includes(providerId)
    ? envelope.secrets.api_keys[providerId]
    : readSessionKeys()[providerId] ?? ''
  if (apiKey === undefined) throw new Error(`API key entry for provider "${providerId}" is missing`)
  return resolveProviderConfig(envelope.settings, apiKey)
}

/** Whether a browser user explicitly chose durable local key storage. */
export function browserProviderKeyPersistence(providerId: string): boolean {
  return !isTauri() && readBrowserEnvelope().remembered_provider_ids.includes(providerId)
}

async function call<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error('Desktop bridge is unavailable in browser preview')
  return invoke<T>(name, args)
}

export async function bootstrap(): Promise<BootstrapState> {
  if (!isTauri()) return { ...await browserData.bootstrap(), provider_catalog: readBrowserEnvelope().settings }
  return call<BootstrapState>('bootstrap')
}

export async function getMessages(conversationId: string): Promise<Message[]> {
  if (!isTauri()) return browserData.getMessages(conversationId)
  return call<Message[]>('get_messages', { conversationId })
}

export async function createConversation(): Promise<Conversation> {
  if (!isTauri()) return browserData.createConversation()
  return call<Conversation>('create_conversation')
}

export async function deleteConversation(conversationId: string): Promise<void> {
  if (!isTauri()) return browserData.deleteConversation(conversationId)
  await call('delete_conversation', { conversationId })
}

export async function setMessageIncluded(messageId: string, included: boolean): Promise<void> {
  if (!isTauri()) return browserData.setMessageIncluded(messageId, included)
  await call('set_message_included', { messageId, included })
}

export async function setReasoningPartIncluded(messageId: string, partId: string, included: boolean): Promise<void> {
  if (isTauri()) return call('set_reasoning_part_included', { messageId, partId, included })
  return browserData.setReasoningPartIncluded(messageId, partId, included)
}

export async function deleteBranch(messageId: string): Promise<void> {
  if (!isTauri()) return browserData.deleteBranch(messageId)
  await call('delete_branch', { messageId })
}

export async function editMessage(messageId: string, content: string, reasoning?: Reasoning | null): Promise<Message> {
  if (isTauri()) return call<Message>('edit_message', { messageId, content, reasoning })
  return browserData.editMessage(messageId, content, reasoning)
}

export async function addTextSource(conversationId: string, name: string, text: string): Promise<WorkspaceSource> {
  if (isTauri()) return call('add_text_source', { conversationId, name, text })
  return browserData.addTextSource(conversationId, name, text)
}

export async function reorderContextSlices(conversationId: string, sliceIds: string[]): Promise<void> {
  if (isTauri()) return call('reorder_context_slices', { conversationId, sliceIds })
  return browserData.reorderContextSlices(conversationId, sliceIds)
}

export async function importSources(conversationId: string, paths: string[]): Promise<WorkspaceSource[]> {
  if (!isTauri()) throw new Error('File import is available in the desktop app')
  return call<WorkspaceSource[]>('import_sources', { conversationId, paths })
}

export async function referenceSource(conversationId: string, sourceId: string): Promise<WorkspaceSource> {
  if (isTauri()) return call('reference_source', { conversationId, sourceId })
  return browserData.referenceSource(conversationId, sourceId)
}

export async function removeSource(sourceId: string): Promise<void> {
  if (!isTauri()) return browserData.removeSource(sourceId)
  await call('remove_source', { sourceId })
}

export async function getSourceLines(sourceId: string, startLine = 1, count = 200): Promise<SourceLines> {
  if (!isTauri()) return browserData.getSourceLines(sourceId, startLine, count)
  return call<SourceLines>('get_source_lines', { sourceId, startLine, count })
}

export async function addContextSlice(args: AddSliceArgs): Promise<ContextSlice> {
  if (!isTauri()) return browserData.addContextSlice(args)
  return call<ContextSlice>('add_context_slice', { args })
}

export async function updateContextSlice(args: UpdateSliceArgs): Promise<void> {
  if (!isTauri()) return browserData.updateContextSlice(args)
  await call('update_context_slice', { args })
}

export async function deleteContextSlice(sliceId: string): Promise<void> {
  if (!isTauri()) return browserData.deleteContextSlice(sliceId)
  await call('delete_context_slice', { sliceId })
}

export async function saveProvider(provider: ProviderProfile, apiKey: string | null, persistBrowserKey?: boolean): Promise<ProviderCatalog> {
  if (!isTauri()) {
    validateProvider(provider)
    const envelope = readBrowserEnvelope()
    const session = readSessionKeys()
    const index = envelope.settings.providers.findIndex((item) => item.id === provider.id)
    if (index < 0) envelope.settings.providers.push(structuredClone(provider))
    else envelope.settings.providers[index] = structuredClone(provider)
    const wasRemembered = envelope.remembered_provider_ids.includes(provider.id)
    const previousApiKey = wasRemembered ? envelope.secrets.api_keys[provider.id] ?? '' : session[provider.id] ?? ''
    const nextApiKey = apiKey ?? previousApiKey
    const remember = persistBrowserKey ?? wasRemembered
    if (remember) {
      if (!wasRemembered) envelope.remembered_provider_ids.push(provider.id)
      envelope.secrets.api_keys[provider.id] = nextApiKey
      delete session[provider.id]
    } else {
      envelope.remembered_provider_ids = envelope.remembered_provider_ids.filter((id) => id !== provider.id)
      envelope.secrets.api_keys[provider.id] = ''
      session[provider.id] = nextApiKey
    }
    const catalog = writeBrowserEnvelope(envelope)
    writeSessionKeys(session)
    return catalog
  }
  return call<ProviderCatalog>('save_provider', { provider, apiKey })
}

export async function deleteProvider(providerId: string): Promise<ProviderCatalog> {
  if (!isTauri()) {
    const envelope = readBrowserEnvelope()
    if (!envelope.settings.providers.some((provider) => provider.id === providerId)) throw new Error(`Provider "${providerId}" does not exist`)
    const session = readSessionKeys()
    envelope.settings.providers = envelope.settings.providers.filter((provider) => provider.id !== providerId)
    envelope.settings.models = envelope.settings.models.filter((model) => model.provider_id !== providerId)
    if (envelope.settings.selected_model_id?.startsWith(`${providerId}::`)) envelope.settings.selected_model_id = null
    delete envelope.secrets.api_keys[providerId]
    envelope.remembered_provider_ids = envelope.remembered_provider_ids.filter((id) => id !== providerId)
    delete session[providerId]
    const catalog = writeBrowserEnvelope(envelope)
    writeSessionKeys(session)
    return catalog
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
  await browserData.getConversation(args.conversationId)
  const browserMessages = await browserData.getMessages(args.conversationId)
  const byId = new Map(browserMessages.map((message) => [message.id, message]))
  const history: Message[] = []
  let currentId = args.parentId
  while (currentId) {
    const message = byId.get(currentId)
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
  const sourceTexts = new Map<string, string>()
  for (const slice of await browserData.getSlices(args.conversationId)) {
    if (!slice.enabled) continue
    let source = sourceTexts.get(slice.source_id)
    if (source === undefined) { source = await browserData.sourceText(slice.source_id); sourceTexts.set(slice.source_id, source) }
    const text = browserData.sliceText(source, { sourceId: slice.source_id, rangeType: slice.range_type,
      startPos: slice.start_pos, endPos: slice.end_pos, wrapper: slice.wrapper, insertAt: slice.insert_at })
    const range = slice.range_type === 'lines' ? ` L${slice.start_pos}-${slice.end_pos}` : slice.range_type === 'chars' ? ` chars ${slice.start_pos}-${slice.end_pos}` : ''
    parts[slice.insert_at].push(slice.wrapper === 'labeled' ? `===== FILE: ${slice.source_name}${range} =====\n${text}` : text)
  }
  const system = join([provider.system_text, join(parts.system)])
  const input = join([join(parts.before_current), args.input, join(parts.inside_current)])
  const images = args.images ?? []
  validateImages(images)
  const allImages = [...selected.flatMap((message) => message.images ?? []), ...images]
  if (allImages.length && !provider.image_input) throw new Error(`${IMAGE_INPUT_HELP} Remove draft images and exclude image messages from history (Include next / No history). No request was sent.`)
  if (allImages.reduce((sum, image) => sum + image.data_url.length, 0) > MAX_REQUEST_IMAGE_URL_BYTES) throw new Error('Too many image bytes in this request. Exclude older image messages from history or use No history.')
  if (!input && !images.length) throw new Error('Request has no current user content')
  const messages = interleaveHistory([
    ...(parts.before_history.length ? [{ role: 'user', content: join(parts.before_history), images: [] }] : []),
    ...selected.map(historyMessage),
    { role: 'user', content: input, images },
  ])
  const extra: unknown = JSON.parse(provider.raw_json_overrides || '{}')
  if (!isRecord(extra)) throw new Error('Raw JSON overrides must be a JSON object')
  const reserved = new Set(['model', 'messages', 'input', 'instructions', 'stream', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'temperature', 'previous_response_id', 'conversation', 'prompt', 'background', 'tools', 'tool_choice', 'functions', 'function_call', 'functionDeclarations', 'parallel_tool_calls', 'web_search_options', 'mcp', 'plugins'])
  for (const key of Object.keys(extra)) if (reserved.has(key)) throw new Error(`Raw JSON override key '${key}' is reserved; request structure is controlled by CeraChat`)
  const wireMessages = wireHistory(messages, provider.protocol)
  const mockTools = messages.some((message) => message.intervention_call_id) ? {
    tools: [provider.protocol === 'openai_responses' ? { type: 'function', ...interventionTool } : { type: 'function', function: interventionTool }], tool_choice: 'none',
  } : {}
  const temperature = provider.temperature === null ? {} : { temperature: provider.temperature }
  const request = provider.protocol === 'openai_responses'
    ? { ...extra, ...temperature, ...mockTools, model: provider.model, ...(system ? { instructions: system } : {}), input: wireMessages, stream: true, max_output_tokens: provider.max_output_tokens }
    : { ...extra, ...temperature, ...mockTools, model: provider.model, messages: [...(system ? [{ role: 'system', content: system }] : []), ...wireMessages], stream: true, max_completion_tokens: provider.max_output_tokens }
  const requestJson = JSON.stringify(request, null, 2)
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(requestJson))
  const historyTokens = selected.reduce((sum, message) => sum + estimateTokens(historyContent(message)), 0)
  let workspaceTokens = Object.values(parts).reduce((sum, values) => sum + estimateTokens(join(values)), 0)
  const separatorCount = Number(parts.before_current.some(Boolean) && Boolean(args.input))
    + Number(parts.inside_current.some(Boolean) && (parts.before_current.some(Boolean) || Boolean(args.input)))
    + Number(Boolean(provider.system_text) && parts.system.some(Boolean))
  const systemTokens = estimateTokens(provider.system_text)
  workspaceTokens += separatorCount * estimateTokens(provider.context_separator)
  const inputTokens = estimateTokens(args.input)
  return {
    request_json: requestJson,
    compiled_prompt: [...(system ? [`[system]\n${system}`] : []), ...messages.map(auditHistory)].join('\n\n'),
    request_sha256: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(''),
    breakdown: { image_count: allImages.length, system_tokens: systemTokens, history_tokens: historyTokens, workspace_tokens: workspaceTokens, input_tokens: inputTokens, estimated_input_tokens: systemTokens + historyTokens + workspaceTokens + inputTokens, configured_context: provider.context_window, max_output_tokens: provider.max_output_tokens },
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

const browserRequests = new Map<string, { cancel: () => void; finished: Promise<void> }>()

/** The audit row and user message are already committed when this runs. */
function startBrowserStream(user: Message, requestId: string, preview: RequestPreview, provider: ProviderConfig, emitUser: boolean): string {
  const controller = new AbortController()
  let content = ''
  let reasoning: Reasoning | null = null
  emitBrowser({ request_id: requestId, conversation_id: user.conversation_id, kind: 'started', user_message: emitUser ? user : undefined })
  const finished = (async () => {
    let status: 'completed' | 'cancelled' | 'failed' = 'completed'
    let error = ''
    try {
      const result = await streamBrowserProviderRequest({
        provider, requestJson: preview.request_json, signal: controller.signal,
        onDelta: (delta) => {
          content += delta.text ?? ''
          reasoning = mergeReasoning(reasoning, delta.reasoning)
          emitBrowser({ request_id: requestId, conversation_id: user.conversation_id, kind: 'delta',
            ...(delta.text !== undefined ? { text: delta.text } : {}), ...(delta.reasoning ? { reasoning: delta.reasoning } : {}) })
        },
      })
      content = result.content
      reasoning = result.reasoning
    } catch (cause) {
      status = controller.signal.aborted ? 'cancelled' : 'failed'
      error = cause instanceof Error ? cause.message : String(cause)
    }
    const assistant: Message | undefined = content || reasoning?.parts.some((part) => part.text)
      ? { id: crypto.randomUUID(), conversation_id: user.conversation_id, parent_id: user.id,
        role: 'assistant', content, ...(reasoning ? { reasoning } : {}), include_next: true, created_at: Date.now() }
      : undefined
    try {
      await browserData.finishRequest(requestId, status, assistant)
    } catch (cause) {
      status = 'failed'
      error = `Could not save provider response: ${cause instanceof Error ? cause.message : String(cause)}`
    } finally {
      browserRequests.delete(requestId)
    }
    emitBrowser({ request_id: requestId, conversation_id: user.conversation_id,
      kind: status === 'completed' ? 'done' : status === 'cancelled' ? 'cancelled' : 'error',
      ...(assistant ? { assistant_message: assistant } : {}), ...(error && status === 'failed' ? { error } : {}) })
  })()
  browserRequests.set(requestId, { cancel: () => controller.abort(), finished })
  return requestId
}

export async function cancelRequest(requestId: string): Promise<void> {
  if (isTauri()) return call<void>('cancel_request', { requestId })
  const request = browserRequests.get(requestId)
  request?.cancel()
  await request?.finished
}

export async function sendMessage(args: CompileRequestArgs): Promise<string> {
  if (isTauri()) return call<string>('send_message', { args })
  const preview = await compileRequest(args)
  const provider = activeBrowserProvider()
  const now = Date.now()
  const user: Message = {
    id: crypto.randomUUID(),
    conversation_id: args.conversationId,
    parent_id: args.parentId,
    role: 'user',
    content: args.input,
    images: structuredClone(args.images ?? []),
    include_next: true,
    created_at: now,
  }
  const requestId = crypto.randomUUID()
  await browserData.beginRequest({ requestId, conversationId: args.conversationId, user, preview, existingUser: false })
  return startBrowserStream(user, requestId, preview, provider, true)
}

export async function regenerateResponse(args: RegenerateArgs): Promise<string> {
  if (isTauri()) return call<string>('regenerate_response', { args })
  const provider = activeBrowserProvider()
  const user = await browserData.getMessage(args.userMessageId)
  if (!user || user.conversation_id !== args.conversationId || user.role !== 'user') {
    throw new Error('The user message for this response is no longer available')
  }

  const preview = await compileRequest({ conversationId: args.conversationId, parentId: user.parent_id,
    input: user.content, images: user.images, historyMode: args.historyMode, sinceMessageId: args.sinceMessageId })
  const requestId = crypto.randomUUID()
  await browserData.beginRequest({ requestId, conversationId: args.conversationId, user, preview, existingUser: true })
  return startBrowserStream(user, requestId, preview, provider, false)
}
