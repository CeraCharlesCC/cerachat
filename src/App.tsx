import { useEffect, useMemo, useRef, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { PanelLeft, PanelRight, Settings, X } from 'lucide-react'
import { ChatThread } from './components/chat/ChatThread'
import { Composer } from './components/chat/Composer'
import { ContextSidebar } from './components/context/ContextSidebar'
import { ProviderSettings } from './components/dialogs/ProviderSettings'
import { RequestInspector } from './components/dialogs/RequestInspector'
import { MessageEditor } from './components/dialogs/MessageEditor'
import { TextSourceDialog } from './components/dialogs/TextSourceDialog'
import { ReferenceSourceDialog } from './components/dialogs/ReferenceSourceDialog'
import { SourceViewer } from './components/dialogs/SourceViewer'
import { ProviderModelSelector } from './components/model/ProviderModelSelector'
import { ThreadSidebar } from './components/navigation/ThreadSidebar'
import { Button } from './components/ui/Button'
import { IconButton } from './components/ui/IconButton'
import { ResizeHandle } from './components/ui/ResizeHandle'
import { fitSidebars, usePanelSize, useViewportSize } from './lib/panelLayout'
import {
  addContextSlice,
  addTextSource,
  editMessage,
  reorderContextSlices,
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
  referenceSource,
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
  const [editingMessage, setEditingMessage] = useState<Message | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [referenceOpen, setReferenceOpen] = useState(false)
  const [attachmentWrapper, setAttachmentWrapper] = useState<WrapperMode>('labeled')
  const [attachmentPosition, setAttachmentPosition] = useState<InsertAt>('inside_current')
  const [autoInclude, setAutoInclude] = useState(true)
  const selectedLeavesRef = useRef(new Map<string, string>())
  const [streaming, setStreaming] = useState<{ requestId: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [compactLayout, setCompactLayout] = useState(() => typeof window !== 'undefined' && window.matchMedia(compactLayoutQuery).matches)
  const [threadsOpen, setThreadsOpen] = useState(() => typeof window === 'undefined' || !window.matchMedia(compactLayoutQuery).matches)
  const [contextOpen, setContextOpen] = useState(() => typeof window === 'undefined' || !window.matchMedia(compactLayoutQuery).matches)
  const viewport = useViewportSize()
  const [preferredThreadsWidth, setThreadsWidth] = usePanelSize('threads', 220)
  const [preferredContextWidth, setContextWidth] = usePanelSize('context', 320)
  const [preferredComposerHeight, setComposerHeight] = usePanelSize('composer', 224)
  const sidebarSpace = viewport.width - 440 - (threadsOpen ? 6 : 0) - (contextOpen ? 6 : 0)
  const widths = fitSidebars(sidebarSpace, threadsOpen ? Math.min(400, Math.max(200, preferredThreadsWidth)) : 0, contextOpen ? Math.min(560, Math.max(300, preferredContextWidth)) : 0)
  const threadsMax = Math.min(400, sidebarSpace - widths.context)
  const contextMax = Math.min(560, sidebarSpace - widths.threads)
  const composerMax = Math.max(200, Math.min(viewport.height * 0.6, viewport.height - 300))
  const composerHeight = Math.min(composerMax, Math.max(200, preferredComposerHeight))
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
    const saved = selectedLeavesRef.current.get(id)
    setActiveLeafId(saved && nextMessages.some((message) => message.id === saved) ? saved : latestLeaf(nextMessages))
    setStreaming(null)
    stickToBottomRef.current = true
  }

  useEffect(() => { void refreshBootstrap().catch((reason) => setError(String(reason))) }, [])

  useEffect(() => {
    if (conversationId && activeLeafId && messages.some((message) => message.id === activeLeafId && message.conversation_id === conversationId)) selectedLeavesRef.current.set(conversationId, activeLeafId)
  }, [conversationId, activeLeafId, messages])

  useEffect(() => {
    setPreview(null)
    setViewerSource(null)
    setPasteOpen(false)
    setReferenceOpen(false)
    setEditingMessage(null)
    if (!conversationId) { setMessages([]); setActiveLeafId(null); return }
    let cancelled = false
    setMessages([])
    setActiveLeafId(null)
    void getMessages(conversationId).then((nextMessages) => {
      if (cancelled) return
      setMessages(nextMessages)
      const saved = selectedLeavesRef.current.get(conversationId)
      setActiveLeafId(saved && nextMessages.some((message) => message.id === saved) ? saved : latestLeaf(nextMessages))
      stickToBottomRef.current = true
    }).catch((reason) => { if (!cancelled) setError(String(reason)) })
    return () => { cancelled = true }
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
  const chatSources = useMemo(() => (state?.sources ?? []).filter((source) => conversationId !== null && source.conversation_id === conversationId), [state?.sources, conversationId])
  const orderedSlices = useMemo(() => {
    const ids = new Set(chatSources.map((source) => source.id))
    return (state?.slices ?? []).filter((slice) => ids.has(slice.source_id)).sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
  }, [state?.slices, chatSources])
  const workspaceTokens = orderedSlices.filter((slice) => slice.enabled).reduce((sum, slice) => sum + slice.estimated_tokens, 0)
  const historyTokens = useMemo(() => {
    let selected = historyMode === 'no_history' ? [] : historyMode === 'last10' ? path.slice(-10) : path
    if (historyMode === 'since_here') {
      const index = path.findIndex((message) => message.id === sinceMessageId)
      selected = index < 0 ? [] : path.slice(index)
    }
    return selected.filter((message) => message.include_next).reduce((sum, message) => sum + estimateTokens(message.content), 0)
  }, [path, historyMode, sinceMessageId])
  const input = conversationId ? drafts[conversationId] ?? "" : ""
  const sendParentId = activeLeafId
  const catalog = state?.provider_catalog
  const activeModel = catalog?.models.find((model) => `${model.provider_id}::${model.model_id}` === catalog.selected_model_id)
  const activeProvider = catalog?.providers.find((provider) => provider.id === activeModel?.provider_id)
  const hasActiveModel = Boolean(activeModel && activeProvider)
  const canCompile = Boolean(conversationId)
    && hasActiveModel
    && !catalogBusy
    && !busy
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
    if (!conversationId || !hasActiveModel || catalogBusy || busy || streaming) return
    const user = assistant.role === "user" ? assistant : assistant.parent_id ? byId.get(assistant.parent_id) : undefined
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

  const mutateContext = async (operation: () => Promise<unknown>) => {
    if (busy || streaming) return
    setBusy(true)
    setError(null)
    setPreview(null)
    try { await operation(); await refreshBootstrap() }
    catch (reason) { setError(String(reason)); await refreshBootstrap().catch(() => {}) }
    finally { setBusy(false) }
  }

  const includeSource = (source: WorkspaceSource, wrapper = attachmentWrapper) => addContextSlice({ sourceId: source.id, rangeType: 'all', wrapper, insertAt: attachmentPosition })

  const reorderSlices = async (draggedId: string, targetId: string) => {
    const ids = orderedSlices.map((slice) => slice.id)
    const from = ids.indexOf(draggedId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0 || from === to) return
    ids.splice(from, 1)
    ids.splice(to, 0, draggedId)
    await mutateContext(() => reorderContextSlices(conversationId as string, ids))
  }

  const moveSlice = (slice: ContextSlice, direction: -1 | 1) => {
    const neighbor = orderedSlices[orderedSlices.findIndex((item) => item.id === slice.id) + direction]
    if (neighbor) void reorderSlices(slice.id, neighbor.id)
  }

  const addAllSources = () => mutateContext(async () => {
    for (const source of chatSources) await includeSource(source)
  })

  const handleImport = async () => {
    if (!conversationId || busy || streaming) return
    if (!isTauri()) { setError('File import is available in the desktop build. Use Paste text in browser preview.'); return }
    try {
      const chosen = await open({ multiple: true, directory: false, filters: [{ name: 'Text or ZIP', extensions: ['txt', 'md', 'json', 'log', 'csv', 'zip'] }] })
      if (!chosen) return
      const paths = Array.isArray(chosen) ? chosen : [chosen]
      await mutateContext(async () => {
        const sources = await importSources(conversationId, paths)
        if (autoInclude) for (const source of sources) await includeSource(source)
      })
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
    <div onDragOver={(event) => {
      if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'none' }
    }} onDrop={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} className="grid h-dvh overflow-hidden bg-background text-foreground" style={{ gridTemplateColumns: compactLayout ? 'minmax(0, 1fr)' : `${threadsOpen ? `${widths.threads}px 6px ` : ''}minmax(0, 1fr)${contextOpen ? ` 6px ${widths.context}px` : ''}` }}>
      {compactLayout && (threadsOpen || contextOpen) && (
        <button className="fixed inset-0 z-30 border-0 bg-black/35" aria-label="Close side panel" onClick={() => { setThreadsOpen(false); setContextOpen(false) }} />
      )}

      <ThreadSidebar
        open={threadsOpen}
        disabled={busy || Boolean(streaming)}
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

      {!compactLayout && threadsOpen && <ResizeHandle label="Resize threads panel" controls="threads-panel" value={widths.threads} min={200} max={threadsMax} onChange={setThreadsWidth} onReset={() => setThreadsWidth(220)} />}

      <main className="chat-main flex min-h-0 min-w-0 flex-col bg-background">
        <header className="relative z-20 flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-border/60 bg-background/85 px-4 backdrop-blur-md">
          <div className="flex min-w-0 items-center gap-2.5">
            {compactLayout && <Button variant="outline" size="sm" aria-expanded={threadsOpen} aria-controls="threads-panel" onClick={toggleThreads}>Threads</Button>}
            {!compactLayout && <IconButton aria-label="Toggle threads panel" aria-expanded={threadsOpen} aria-controls="threads-panel" title="Toggle threads panel" onClick={toggleThreads}><PanelLeft size={18} /></IconButton>}
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
            {compactLayout && <Button variant="outline" size="sm" aria-expanded={contextOpen} aria-controls="context-panel" onClick={toggleContext}>Context</Button>}
            {!compactLayout && <IconButton aria-label="Toggle context panel" aria-expanded={contextOpen} aria-controls="context-panel" title="Toggle context panel" onClick={toggleContext}><PanelRight size={18} /></IconButton>}
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
          messages={messages}
          onSelectSibling={(message) => {
            let leaf = message
            const visited = new Set<string>()
            while (!visited.has(leaf.id)) {
              visited.add(leaf.id)
              const children = messages.filter((item) => item.parent_id === leaf.id)
              if (!children.length) break
              leaf = children[children.length - 1]
            }
            selectLeaf(leaf.id)
          }}
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
          onEdit={setEditingMessage}
          onCopy={(message) => void handleCopyMessage(message)}
          onRegenerate={(message) => void handleRegenerate(message)}
          onDelete={(message) => { if (confirm('Delete this message and all descendants?')) void deleteBranch(message.id).then(async () => { if (conversationId) await loadConversation(conversationId); await refreshBootstrap() }).catch((reason) => setError(String(reason))) }}
        />
        <ResizeHandle label="Resize message composer" controls="message-composer" orientation="horizontal" direction={-1} value={composerHeight} min={200} max={composerMax} onChange={setComposerHeight} onReset={() => setComposerHeight(224)} />
        <Composer
          height={composerHeight}
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

      {!compactLayout && contextOpen && <ResizeHandle label="Resize context panel" controls="context-panel" direction={-1} value={widths.context} min={300} max={contextMax} onChange={setContextWidth} onReset={() => setContextWidth(320)} />}

      <ContextSidebar
        open={contextOpen}
        sources={chatSources}
        slices={orderedSlices}
        workspaceTokens={workspaceTokens}
        busy={!conversationId || busy || Boolean(streaming)}
        wrapper={attachmentWrapper}
        insertAt={attachmentPosition}
        autoInclude={autoInclude}
        onWrapperChange={setAttachmentWrapper}
        onInsertAtChange={setAttachmentPosition}
        onAutoIncludeChange={setAutoInclude}
        onPaste={() => setPasteOpen(true)}
        onReference={() => setReferenceOpen(true)}
        onReorder={(draggedId, targetId) => void reorderSlices(draggedId, targetId)}
        onImport={() => void handleImport()}
        onAddAll={() => void addAllSources()}
        onOpenSource={setViewerSource}
        onAddSource={(source) => void mutateContext(() => includeSource(source))}
        onRemoveSource={(source) => { if (confirm('Remove this source and its live context slices? Past request snapshots remain reproducible.')) void mutateContext(() => removeSource(source.id)) }}
        onChangeSlice={(slice, patch) => void mutateContext(() => updateContextSlice({ sliceId: slice.id, ...patch }))}
        onDeleteSlice={(slice) => void mutateContext(() => deleteContextSlice(slice.id))}
        onMoveSlice={moveSlice}
      />

      {settingsOpen && <ProviderSettings catalog={state.provider_catalog} onClose={() => setSettingsOpen(false)} onCatalogChange={updateCatalog} />}
      {preview && <RequestInspector preview={preview} onClose={() => setPreview(null)} />}
      {editingMessage && <MessageEditor key={editingMessage.id} message={editingMessage} onClose={() => setEditingMessage(null)} onSave={async (content) => {
        setBusy(true)
        try {
          const edited = await editMessage(editingMessage.id, content)
          setMessages((current) => [...current.filter((message) => message.id !== edited.id), edited])
          selectLeaf(edited.id)
          setPreview(null)
          setEditingMessage(null)
          await refreshBootstrap()
        } finally { setBusy(false) }
      }} />}
      {referenceOpen && conversationId && <ReferenceSourceDialog
        sources={state.sources.filter((source) => source.conversation_id !== conversationId)}
        conversations={state.conversations}
        onClose={() => setReferenceOpen(false)}
        onAdd={async (source) => {
          setBusy(true)
          try {
            const referenced = await referenceSource(conversationId, source.id)
            if (autoInclude) await includeSource(referenced)
            await refreshBootstrap()
            setPreview(null)
            setReferenceOpen(false)
          } finally { setBusy(false) }
        }}
      />}
      {pasteOpen && conversationId && <TextSourceDialog onClose={() => setPasteOpen(false)} onAdd={async (name, text) => {
        setBusy(true)
        try {
          const source = await addTextSource(conversationId, name, text)
          if (autoInclude) await includeSource(source)
          await refreshBootstrap()
          setPreview(null)
          setPasteOpen(false)
        } finally { setBusy(false) }
      }} />}
      {viewerSource && <SourceViewer key={viewerSource.id} source={viewerSource} wrapper={attachmentWrapper} insertAt={attachmentPosition} onClose={() => setViewerSource(null)} onLoadLines={getSourceLines} onAdd={async (args) => {
        setBusy(true)
        try {
          await addContextSlice(args)
          await refreshBootstrap()
          setPreview(null)
          setViewerSource(null)
        } finally { setBusy(false) }
      }} />}

    </div>
  )
}
