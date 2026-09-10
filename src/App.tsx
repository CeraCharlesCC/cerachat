import { useEffect, useMemo, useRef, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { Settings, X } from 'lucide-react'
import { ChatThread } from './components/chat/ChatThread'
import { Composer } from './components/chat/Composer'
import { ContextSidebar } from './components/context/ContextSidebar'
import { ProviderSettings } from './components/dialogs/ProviderSettings'
import { RequestInspector } from './components/dialogs/RequestInspector'
import { SourceViewer } from './components/dialogs/SourceViewer'
import { ProviderModelSelector } from './components/model/ProviderModelSelector'
import { ThreadSidebar } from './components/navigation/ThreadSidebar'
import { Button } from './components/ui/Button'
import { IconButton } from './components/ui/IconButton'
import {
  addContextSlice,
  bootstrap,
  compileRequest,
  createConversation,
  deleteBranch,
  deleteContextSlice,
  deleteConversation,
  getMessages,
  getSourceLines,
  importSources,
  isTauri,
  removeSource,
  regenerateResponse,
  selectModel,
  sendMessage,
  setMessageIncluded,
  subscribeStream,
  updateContextSlice,
} from './lib/backend'
import { estimateTokens, formatTokens } from './lib/utils'
import type {
  BootstrapState,
  ContextSlice,
  HistoryMode,
  InsertAt,
  Message,
  ProviderCatalog,
  RequestPreview,
  StreamPayload,
  WorkspaceSource,
  WrapperMode,
} from './types'

const compactLayoutQuery = '(max-width: 1100px)'

function messagePath(messages: Message[], leafId: string | null): Message[] {
  if (!leafId) return []
  const byId = new Map(messages.map((message) => [message.id, message]))
  const path: Message[] = []
  let current = byId.get(leafId)
  let guard = 0
  while (current && guard < messages.length + 1) {
    path.push(current)
    current = current.parent_id ? byId.get(current.parent_id) : undefined
    guard += 1
  }
  return path.reverse()
}

function latestLeaf(messages: Message[]): string | null {
  if (!messages.length) return null
  const parentIds = new Set(messages.flatMap((message) => message.parent_id ? [message.parent_id] : []))
  const leaves = messages.filter((message) => !parentIds.has(message.id))
  return (leaves[leaves.length - 1] ?? messages[messages.length - 1])?.id ?? null
}

export default function App() {
  const [state, setState] = useState<BootstrapState | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null)
  const [historyMode, setHistoryMode] = useState<HistoryMode>('full')
  const [sinceMessageId, setSinceMessageId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<RequestPreview | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [viewerSource, setViewerSource] = useState<WorkspaceSource | null>(null)
  const [streaming, setStreaming] = useState<{ requestId: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [compactLayout, setCompactLayout] = useState(() => typeof window !== 'undefined' && window.matchMedia(compactLayoutQuery).matches)
  const [threadsOpen, setThreadsOpen] = useState(() => typeof window === 'undefined' || !window.matchMedia(compactLayoutQuery).matches)
  const [contextOpen, setContextOpen] = useState(() => typeof window === 'undefined' || !window.matchMedia(compactLayoutQuery).matches)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const restoreLeafOnErrorRef = useRef<string | null>(null)

  useEffect(() => {
    const query = window.matchMedia(compactLayoutQuery)
    const onLayoutChange = () => {
      setCompactLayout(query.matches)
      setThreadsOpen(!query.matches)
      setContextOpen(!query.matches)
    }
    query.addEventListener('change', onLayoutChange)
    return () => query.removeEventListener('change', onLayoutChange)
  }, [])

  const refreshBootstrap = async () => {
    try {
      const next = await bootstrap()
      setState(next)
      setConversationId((current) => current && next.conversations.some((item) => item.id === current) ? current : next.conversations[0]?.id ?? null)
    } catch (reason) {
      setState(null)
      setError(String(reason))
      throw reason
    }
  }

  const updateCatalog = (catalog: ProviderCatalog) => {
    setState((current) => current ? { ...current, provider_catalog: catalog } : current)
    setPreview(null)
  }

  const handleRequestError = async (reason: unknown) => {
    setError(String(reason))
    // Another app instance may have changed or removed the saved selection.
    await refreshBootstrap().catch(() => { /* Bootstrap already surfaces local loading errors. */ })
  }

  const loadConversation = async (id: string) => {
    const nextMessages = await getMessages(id)
    setMessages(nextMessages)
    setActiveLeafId(latestLeaf(nextMessages))
    setStreaming(null)
    stickToBottomRef.current = true
  }

  useEffect(() => { void refreshBootstrap().catch((reason) => setError(String(reason))) }, [])

  useEffect(() => {
    if (!conversationId) { setMessages([]); setActiveLeafId(null); return }
    void loadConversation(conversationId).catch((reason) => setError(String(reason)))
  }, [conversationId])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    void subscribeStream((payload: StreamPayload) => {
      if (payload.conversation_id !== conversationId) return
      if (payload.kind === 'started') {
        if (payload.user_message) {
          setMessages((current) => [...current.filter((message) => message.id !== payload.user_message?.id), payload.user_message as Message])
          setActiveLeafId(payload.user_message.id)
        }
        stickToBottomRef.current = true
        setStreaming({ requestId: payload.request_id, text: '' })
      } else if (payload.kind === 'delta') {
        setStreaming((current) => current && current.requestId === payload.request_id ? { ...current, text: current.text + (payload.text ?? '') } : current)
      } else if (payload.kind === 'done' && payload.assistant_message) {
        setMessages((current) => [...current.filter((message) => message.id !== payload.assistant_message?.id), payload.assistant_message as Message])
        setActiveLeafId(payload.assistant_message.id)
        restoreLeafOnErrorRef.current = null
        setStreaming(null)
        void refreshBootstrap().catch((reason) => setError(String(reason)))
      } else if (payload.kind === 'error') {
        setError(payload.error ?? 'Provider request failed')
        if (restoreLeafOnErrorRef.current) setActiveLeafId(restoreLeafOnErrorRef.current)
        restoreLeafOnErrorRef.current = null
        setStreaming(null)
        void refreshBootstrap().catch((reason) => setError(String(reason)))
      }
    }).then((cleanup) => { unlisten = cleanup })
    return () => { unlisten?.() }
  }, [conversationId])

  const path = useMemo(() => messagePath(messages, activeLeafId), [messages, activeLeafId])
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages])
  const orderedSlices = useMemo(() => [...(state?.slices ?? [])].sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id)), [state?.slices])
  const workspaceTokens = orderedSlices.filter((slice) => slice.enabled).reduce((sum, slice) => sum + slice.estimated_tokens, 0)
  const historyTokens = path.filter((message) => message.include_next).reduce((sum, message) => sum + estimateTokens(message.content), 0)
  const input = conversationId ? drafts[conversationId] ?? "" : ""
  const sendParentId = activeLeafId && byId.get(activeLeafId)?.role === "user" ? byId.get(activeLeafId)?.parent_id ?? null : activeLeafId
  const catalog = state?.provider_catalog
  const activeModel = catalog?.models.find((model) => `${model.provider_id}::${model.model_id}` === catalog.selected_model_id)
  const activeProvider = catalog?.providers.find((provider) => provider.id === activeModel?.provider_id)
  const hasActiveModel = Boolean(activeModel && activeProvider)
  const canCompile = Boolean(conversationId)
    && hasActiveModel
    && !catalogBusy
    && !streaming
    && (input.length > 0 || workspaceTokens > 0)
    && (historyMode !== "since_here" || Boolean(sinceMessageId))

  useEffect(() => {
    if (sinceMessageId && !path.some((message) => message.id === sinceMessageId)) setSinceMessageId(null)
  }, [path, sinceMessageId])

  useEffect(() => {
    if (stickToBottomRef.current) messagesEndRef.current?.scrollIntoView({ block: "end" })
  }, [activeLeafId, path.length, streaming?.text])

  const requestArgs = () => ({
    conversationId: conversationId as string,
    parentId: sendParentId,
    input,
    historyMode,
    sinceMessageId: historyMode === "since_here" ? sinceMessageId : null,
  })

  const handleSend = async () => {
    if (!conversationId || !canCompile || busy) return
    setError(null)
    restoreLeafOnErrorRef.current = null
    stickToBottomRef.current = true
    setBusy(true)
    try {
      await sendMessage(requestArgs())
      setDrafts((current) => ({ ...current, [conversationId]: "" }))
      textareaRef.current?.focus()
    } catch (reason) {
      await handleRequestError(reason)
    } finally {
      setBusy(false)
    }
  }

  const handlePreview = async () => {
    if (!conversationId || !canCompile) return
    setError(null)
    try { setPreview(await compileRequest(requestArgs())) } catch (reason) { await handleRequestError(reason) }
  }

  const handleRegenerate = async (assistant: Message) => {
    if (!conversationId || !hasActiveModel || catalogBusy || busy || streaming || assistant.role !== "assistant" || !assistant.parent_id) return
    const user = byId.get(assistant.parent_id)
    if (!user || user.role !== "user") {
      setError("The user message for this response is no longer available.")
      return
    }
    if (historyMode === "since_here") {
      const earlierHistory = messagePath(messages, user.parent_id)
      if (!sinceMessageId || !earlierHistory.some((message) => message.id === sinceMessageId)) {
        setError("Choose a Since here message before the response you want to regenerate.")
        return
      }
    }
    setError(null)
    setBusy(true)
    restoreLeafOnErrorRef.current = assistant.id
    stickToBottomRef.current = true
    setActiveLeafId(user.id)
    try {
      await regenerateResponse({
        conversationId,
        userMessageId: user.id,
        historyMode,
        sinceMessageId: historyMode === "since_here" ? sinceMessageId : null,
      })
    } catch (reason) {
      restoreLeafOnErrorRef.current = null
      setActiveLeafId(assistant.id)
      await handleRequestError(reason)
    } finally {
      setBusy(false)
    }
  }

  const handleCopyMessage = async (message: Message) => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopiedMessageId(message.id)
      window.setTimeout(() => setCopiedMessageId((current) => current === message.id ? null : current), 1400)
    } catch (reason) {
      setError(`Could not copy message: ${String(reason)}`)
    }
  }

  const updateSlice = async (slice: ContextSlice, patch: { enabled?: boolean; wrapper?: WrapperMode; insertAt?: InsertAt; sortOrder?: number }) => {
    await updateContextSlice({ sliceId: slice.id, ...patch })
    await refreshBootstrap()
  }

  const moveSlice = async (slice: ContextSlice, direction: -1 | 1) => {
    const index = orderedSlices.findIndex((item) => item.id === slice.id)
    const neighbor = orderedSlices[index + direction]
    if (!neighbor) return
    await updateContextSlice({ sliceId: slice.id, sortOrder: neighbor.sort_order })
    await updateContextSlice({ sliceId: neighbor.id, sortOrder: slice.sort_order })
    await refreshBootstrap()
  }

  const addAllSources = async (wrapper: WrapperMode) => {
    if (!state) return
    setBusy(true)
    try {
      for (const source of state.sources) {
        if (!state.slices.some((slice) => slice.source_id === source.id && slice.range_type === 'all')) {
          await addContextSlice({ sourceId: source.id, rangeType: 'all', wrapper, insertAt: 'before_current' })
        }
      }
      await refreshBootstrap()
    } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }

  const handleImport = async () => {
    if (!isTauri()) { setError('File import is available in the Tauri desktop build.'); return }
    try {
      const chosen = await open({ multiple: true, directory: false, filters: [{ name: 'Text or ZIP', extensions: ['txt', 'md', 'json', 'log', 'csv', 'zip'] }] })
      if (!chosen) return
      const paths = Array.isArray(chosen) ? chosen : [chosen]
      await importSources(paths)
      await refreshBootstrap()
    } catch (reason) { setError(String(reason)) }
  }

  if (!state) return (
    <div className="grid h-screen place-items-center p-6 text-sm text-muted-foreground">
      {error ? (
        <div className="max-w-xl rounded-2xl border border-destructive/30 bg-card p-6">
          <h1 className="mt-0 text-lg font-semibold text-foreground">Could not open local workspace</h1>
          <p className="break-words text-destructive" role="alert">{error}</p>
          <Button variant="outline" onClick={() => { setError(null); void refreshBootstrap().catch((reason) => setError(String(reason))) }}>Retry</Button>
        </div>
      ) : 'Opening local workspace…'}
    </div>
  )

  const selectLeaf = (messageId: string) => {
    stickToBottomRef.current = true
    setActiveLeafId(messageId)
  }
  const toggleThreads = () => {
    setThreadsOpen((current) => !current)
    if (compactLayout) setContextOpen(false)
  }
  const toggleContext = () => {
    setContextOpen((current) => !current)
    if (compactLayout) setThreadsOpen(false)
  }

  return (
    <div className="grid h-dvh overflow-hidden bg-background text-foreground grid-cols-[240px_minmax(0,1fr)_320px] max-[1180px]:grid-cols-[210px_minmax(0,1fr)_300px] max-[1100px]:grid-cols-1">
      {compactLayout && (threadsOpen || contextOpen) && (
        <button className="fixed inset-0 z-30 border-0 bg-black/35" aria-label="Close side panel" onClick={() => { setThreadsOpen(false); setContextOpen(false) }} />
      )}

      <ThreadSidebar
        open={threadsOpen}
        conversations={state.conversations}
        conversationId={conversationId}
        messages={messages}
        activeLeafId={activeLeafId}
        dataDir={state.data_dir}
        desktop={isTauri()}
        onNewChat={() => void createConversation().then(async (conversation) => { await refreshBootstrap(); setConversationId(conversation.id) }).catch((reason) => setError(String(reason)))}
        onSelectConversation={setConversationId}
        onDeleteConversation={(id) => { if (confirm('Delete this conversation and its message tree?')) void deleteConversation(id).then(refreshBootstrap).catch((reason) => setError(String(reason))) }}
        onSelectLeaf={selectLeaf}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="flex min-h-0 min-w-0 flex-col bg-background">
        <header className="relative z-20 flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-border/60 bg-background/85 px-4 backdrop-blur-md">
          <div className="flex min-w-0 items-center gap-2.5">
            <Button variant="outline" size="sm" className="hidden max-[1100px]:inline-flex" aria-expanded={threadsOpen} aria-controls="threads-panel" onClick={toggleThreads}>Threads</Button>
            <ProviderModelSelector
              catalog={state.provider_catalog}
              disabled={busy || catalogBusy || Boolean(streaming)}
              onSelect={async (id) => {
                setCatalogBusy(true)
                try {
                  updateCatalog(await selectModel(id))
                } catch (reason) {
                  await refreshBootstrap().catch(() => { /* Bootstrap already surfaces local loading errors. */ })
                  throw reason
                } finally {
                  setCatalogBusy(false)
                }
              }}
            />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" className="hidden max-[1100px]:inline-flex" aria-expanded={contextOpen} aria-controls="context-panel" onClick={toggleContext}>Context</Button>
            <IconButton aria-label="Provider settings" title="Provider settings" onClick={() => setSettingsOpen(true)}><Settings size={16} /></IconButton>
            <div className="flex w-28 flex-col items-end overflow-hidden px-1 py-1.5 tabular-nums max-sm:hidden">
              <span className="text-[11px] font-semibold">{formatTokens(historyTokens + workspaceTokens + estimateTokens(input))} input</span>
              <small className="text-[9px] text-muted-foreground">{formatTokens(workspaceTokens)} workspace</small>
            </div>
          </div>
        </header>
        {error && (
          <div className="mx-4 mt-2 flex items-center justify-between gap-3 rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
            <span className="min-w-0 break-words">{error}</span>
            <IconButton className="size-7 text-destructive" aria-label="Dismiss error" onClick={() => setError(null)}><X size={14} /></IconButton>
          </div>
        )}
        {!hasActiveModel && (
          <div className="mx-4 mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground" role="status">
            <span>{state.provider_catalog.selected_model_id ? 'The selected model is unavailable.' : 'Choose a saved model to preview or send a request.'}</span>
            <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>Configure providers</Button>
          </div>
        )}
        <ChatThread
          path={path}
          streamingText={streaming?.text ?? null}
          copiedMessageId={copiedMessageId}
          actionsDisabled={busy || Boolean(streaming)}
          regenerateDisabled={!hasActiveModel || catalogBusy}
          messagesEndRef={messagesEndRef}
          onScroll={(event) => {
            const viewport = event.currentTarget
            stickToBottomRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48
          }}
          onIncludedChange={(message, included) => {
            setMessages((current) => current.map((item) => item.id === message.id ? { ...item, include_next: included } : item))
            void setMessageIncluded(message.id, included).catch((reason) => setError(String(reason)))
          }}
          onCopy={(message) => void handleCopyMessage(message)}
          onRegenerate={(message) => void handleRegenerate(message)}
          onDelete={(message) => { if (confirm('Delete this message and all descendants?')) void deleteBranch(message.id).then(async () => { if (conversationId) await loadConversation(conversationId); await refreshBootstrap() }).catch((reason) => setError(String(reason))) }}
        />
        <Composer
          textareaRef={textareaRef}
          input={input}
          historyMode={historyMode}
          sinceMessageId={sinceMessageId}
          path={path}
          historyTokens={historyTokens}
          workspaceTokens={workspaceTokens}
          canCompile={canCompile}
          busy={busy}
          streaming={Boolean(streaming)}
          onInputChange={(value) => { if (conversationId) setDrafts((current) => ({ ...current, [conversationId]: value })) }}
          onHistoryModeChange={setHistoryMode}
          onSinceMessageChange={setSinceMessageId}
          onPreview={() => void handlePreview()}
          onSend={() => void handleSend()}
        />
      </main>

      <ContextSidebar
        open={contextOpen}
        sources={state.sources}
        slices={orderedSlices}
        workspaceTokens={workspaceTokens}
        busy={busy}
        onImport={() => void handleImport()}
        onAddAll={(wrapper) => void addAllSources(wrapper)}
        onOpenSource={setViewerSource}
        onAddSource={(source) => void addContextSlice({ sourceId: source.id, rangeType: 'all', wrapper: 'raw', insertAt: 'before_current' }).then(refreshBootstrap).catch((reason) => setError(String(reason)))}
        onRemoveSource={(source) => { if (confirm('Remove this source and its live context slices? Past request snapshots remain reproducible.')) void removeSource(source.id).then(refreshBootstrap).catch((reason) => setError(String(reason))) }}
        onChangeSlice={(slice, patch) => void updateSlice(slice, patch).catch((reason) => setError(String(reason)))}
        onDeleteSlice={(slice) => void deleteContextSlice(slice.id).then(refreshBootstrap).catch((reason) => setError(String(reason)))}
        onMoveSlice={(slice, direction) => void moveSlice(slice, direction).catch((reason) => setError(String(reason)))}
      />

      {settingsOpen && <ProviderSettings catalog={state.provider_catalog} onClose={() => setSettingsOpen(false)} onCatalogChange={updateCatalog} />}
      {preview && <RequestInspector preview={preview} onClose={() => setPreview(null)} />}
      {viewerSource && <SourceViewer source={viewerSource} onClose={() => setViewerSource(null)} onLoadLines={getSourceLines} onAdd={async (start, end) => { await addContextSlice({ sourceId: viewerSource.id, rangeType: 'lines', startPos: start, endPos: end, wrapper: 'raw', insertAt: 'before_current' }); await refreshBootstrap(); setViewerSource(null) }} />}
    </div>
  )
}
