import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { demoBootstrap, demoMessages, demoPreview, demoSourceLines } from './demo'
import type {
  AddSliceArgs,
  BootstrapState,
  CompileRequestArgs,
  ContextSlice,
  Conversation,
  Message,
  ProviderConfig,
  SourceLines,
  StreamPayload,
  UpdateSliceArgs,
  WorkspaceSource,
} from '../types'

export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

let browserBootstrap: BootstrapState = structuredClone(demoBootstrap)
let browserMessages: Message[] = structuredClone(demoMessages)
const browserListeners = new Set<(payload: StreamPayload) => void>()

async function call<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error('Desktop bridge is unavailable in browser preview')
  return invoke<T>(name, args)
}

export async function bootstrap(): Promise<BootstrapState> {
  if (!isTauri()) return structuredClone(browserBootstrap)
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

export async function saveProvider(provider: ProviderConfig): Promise<void> {
  if (!isTauri()) {
    browserBootstrap.provider = structuredClone(provider)
    return
  }
  await call('save_provider', { provider })
}

export async function compileRequest(args: CompileRequestArgs): Promise<ReturnType<typeof demoPreview>> {
  if (!isTauri()) {
    const history = browserMessages.filter((message) => message.conversation_id === args.conversationId && message.include_next)
    const historyTokens = history.reduce((sum, message) => sum + Math.ceil(message.content.length / 4), 0)
    const workspaceTokens = browserBootstrap.slices.filter((slice) => slice.enabled).reduce((sum, slice) => sum + slice.estimated_tokens, 0)
    return demoPreview(args.input, historyTokens, workspaceTokens)
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
