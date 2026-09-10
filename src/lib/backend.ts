import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { demoBootstrap, demoMessages, demoPreview, demoSourceLines } from './demo'
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

export async function importSources(paths: string[]): Promise<WorkspaceSource[]> {
  if (!isTauri()) throw new Error('File import is available in the desktop app')
  return call<WorkspaceSource[]>('import_sources', { paths })
}

export async function removeSource(sourceId: string): Promise<void> {
  if (!isTauri()) {
    browserBootstrap.sources = browserBootstrap.sources.filter((source) => source.id !== sourceId)
    browserBootstrap.slices = browserBootstrap.slices.filter((slice) => slice.source_id !== sourceId)
    return
  }
  await call('remove_source', { sourceId })
}

export async function getSourceLines(sourceId: string, startLine = 1, count = 200): Promise<SourceLines> {
  if (!isTauri()) return demoSourceLines(sourceId, startLine, count)
  return call<SourceLines>('get_source_lines', { sourceId, startLine, count })
}

export async function addContextSlice(args: AddSliceArgs): Promise<ContextSlice> {
  if (!isTauri()) {
    const source = browserBootstrap.sources.find((item) => item.id === args.sourceId)
    if (!source) throw new Error('Source not found')
    const slice: ContextSlice = {
      id: crypto.randomUUID(),
      source_id: source.id,
      source_name: source.display_name,
      range_type: args.rangeType,
      start_pos: args.startPos ?? null,
      end_pos: args.endPos ?? null,
      enabled: true,
      sort_order: browserBootstrap.slices.length,
      wrapper: args.wrapper,
      insert_at: args.insertAt,
      estimated_tokens: args.rangeType === 'all' ? Math.ceil(source.original_size / 4) : 1200,
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

export async function compileRequest(args: CompileRequestArgs): Promise<ReturnType<typeof demoPreview>> {
  if (!isTauri()) {
    const provider = activeBrowserProvider()
    const history = browserMessages.filter((message) => message.conversation_id === args.conversationId && message.include_next)
    const historyTokens = history.reduce((sum, message) => sum + Math.ceil(message.content.length / 4), 0)
    const workspaceTokens = browserBootstrap.slices.filter((slice) => slice.enabled).reduce((sum, slice) => sum + slice.estimated_tokens, 0)
    return demoPreview(args.input, historyTokens, workspaceTokens, provider)
  }
  return call('compile_request', { args })
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

  activeBrowserProvider()

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
