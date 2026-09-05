import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { open } from '@tauri-apps/plugin-dialog'
import './App.css'
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
  saveProvider,
  sendMessage,
  setMessageIncluded,
  subscribeStream,
  updateContextSlice,
} from './lib/backend'
import { estimateTokens, formatBytes, formatTokens, shortId } from './lib/utils'
import type {
  BootstrapState,
  ContextSlice,
  HistoryMode,
  InsertAt,
  Message,
  ProviderConfig,
  RequestPreview,
  SourceLines,
  StreamPayload,
  WorkspaceSource,
  WrapperMode,
} from './types'

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })
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

function depthFor(message: Message, byId: Map<string, Message>): number {
  let depth = 0
  let parentId = message.parent_id
  let guard = 0
  while (parentId && guard < byId.size) {
    depth += 1
    parentId = byId.get(parentId)?.parent_id ?? null
    guard += 1
  }
  return depth
}

function MarkdownContent({ content }: { content: string }) {
  const html = useMemo(() => DOMPurify.sanitize(markdown.render(content)), [content])
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
}

function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close">×</button></header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  )
}

function ProviderSettings({ provider, onSave, onClose }: { provider: ProviderConfig; onSave: (provider: ProviderConfig) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState<ProviderConfig>({ ...provider })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const update = <K extends keyof ProviderConfig>(key: K, value: ProviderConfig[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const endpointName = draft.protocol === 'openai_responses' ? '/responses' : '/chat/completions'

  const handleSave = async () => {
    if (!draft.base_url.trim() || !draft.model.trim()) return
    setSaveError(null)
    setSaving(true)
    try {
      await onSave(draft)
    } catch (reason) {
      setSaveError(String(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="Provider settings" onClose={onClose} wide>
      <p className="notice">Saving is local only. There is no API test, capability detection, model fetch, or background request.</p>
      <div className="form-grid two-column">
        <label>Provider name<input value={draft.name} onChange={(event) => update('name', event.target.value)} /></label>
        <label>Protocol<select value={draft.protocol} onChange={(event) => update('protocol', event.target.value as ProviderConfig['protocol'])}><option value="openai_chat_completions">OpenAI Chat Completions</option><option value="openai_responses">OpenAI Responses API</option></select></label>
        <label className="span-2">Base URL<input value={draft.base_url} onChange={(event) => update('base_url', event.target.value)} placeholder="https://example.com/v1" /><span className="field-hint">The configured base is normalized to {endpointName} when you send.</span></label>
        <label className="span-2">API key<input type="password" autoComplete="off" value={draft.api_key} onChange={(event) => update('api_key', event.target.value)} /></label>
        <label>API key storage<select value={draft.api_key_storage} onChange={(event) => update('api_key_storage', event.target.value as ProviderConfig['api_key_storage'])}><option value="plain_portable">Plain portable configuration</option><option value="windows_dpapi" disabled>Windows DPAPI (planned)</option></select></label>
        <label>Model ID<input value={draft.model} onChange={(event) => update('model', event.target.value)} /></label>
        <label>Context window<input type="number" min={1} value={draft.context_window} onChange={(event) => update('context_window', Number(event.target.value))} /></label>
        <label>Max output<input type="number" min={1} value={draft.max_output_tokens} onChange={(event) => update('max_output_tokens', Number(event.target.value))} /></label>
        <label>Temperature<input type="number" step="0.1" value={draft.temperature ?? ''} onChange={(event) => update('temperature', event.target.value === '' ? null : Number(event.target.value))} /></label>
        <label className="span-2">System text<textarea rows={5} value={draft.system_text} onChange={(event) => update('system_text', event.target.value)} /></label>
        <label className="span-2">Context separator<textarea rows={3} value={draft.context_separator} onChange={(event) => update('context_separator', event.target.value)} /></label>
        <label className="span-2">Optional raw JSON overrides<textarea className="mono" rows={6} value={draft.raw_json_overrides} onChange={(event) => update('raw_json_overrides', event.target.value)} /></label>
      </div>
      {saveError && <p className="form-error" role="alert">{saveError}</p>}
      <div className="modal-actions"><button onClick={onClose}>Cancel</button><button className="primary" disabled={saving || !draft.base_url.trim() || !draft.model.trim()} onClick={() => void handleSave()}>{saving ? 'Saving…' : 'Save locally'}</button></div>
    </Modal>
  )
}

function RequestInspector({ preview, onClose }: { preview: RequestPreview; onClose: () => void }) {
  const b = preview.breakdown
  return (
    <Modal title="Request preview" onClose={onClose} wide>
      <div className="request-summary">
        <div><span>System</span><strong>{formatTokens(b.system_tokens)}</strong></div>
        <div><span>History</span><strong>{formatTokens(b.history_tokens)}</strong></div>
        <div><span>Workspace</span><strong>{formatTokens(b.workspace_tokens)}</strong></div>
        <div><span>Current input</span><strong>{formatTokens(b.input_tokens)}</strong></div>
        <div className="summary-total"><span>Estimated input</span><strong>{formatTokens(b.estimated_input_tokens)}</strong></div>
        <div><span>Max output</span><strong>{formatTokens(b.max_output_tokens)}</strong></div>
        <div><span>Configured context</span><strong>{formatTokens(b.configured_context)}</strong></div>
      </div>
      <div className="hash-row"><span>SHA-256</span><code>{preview.request_sha256}</code><button onClick={() => void navigator.clipboard?.writeText(preview.request_json)}>Copy JSON</button></div>
      <h3>Actual request JSON</h3>
      <pre className="request-code">{preview.request_json}</pre>
      <details><summary>Compiled prompt audit view</summary><pre className="request-code">{preview.compiled_prompt}</pre></details>
    </Modal>
  )
}

function SourceViewer({ source, onClose, onAdd }: { source: WorkspaceSource; onClose: () => void; onAdd: (start: number, end: number) => Promise<void> }) {
  const [windowStart, setWindowStart] = useState(1)
  const [lines, setLines] = useState<SourceLines | null>(null)
  const [rangeStart, setRangeStart] = useState(1)
  const [rangeEnd, setRangeEnd] = useState(Math.min(source.line_count || 1, 200))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getSourceLines(source.id, windowStart, 200).then((result) => { if (!cancelled) setLines(result) })
    return () => { cancelled = true }
  }, [source.id, windowStart])

  return (
    <Modal title={source.display_name} onClose={onClose} wide>
      <div className="viewer-toolbar">
        <span>{source.line_count.toLocaleString()} lines · {formatBytes(source.original_size)}</span>
        <div><button disabled={windowStart <= 1} onClick={() => setWindowStart(Math.max(1, windowStart - 200))}>← 200</button><button disabled={windowStart + 200 > source.line_count} onClick={() => setWindowStart(windowStart + 200)}>200 →</button></div>
      </div>
      <div className="line-viewer">
        {lines?.lines.map((line, index) => <div className="source-line" key={lines.start_line + index}><span>{lines.start_line + index}</span><code>{line || ' '}</code></div>)}
      </div>
      <div className="range-bar">
        <label>From line<input type="number" min={1} max={source.line_count} value={rangeStart} onChange={(event) => setRangeStart(Number(event.target.value))} /></label>
        <label>To line<input type="number" min={rangeStart} max={source.line_count} value={rangeEnd} onChange={(event) => setRangeEnd(Number(event.target.value))} /></label>
        <button className="primary" disabled={busy || rangeStart < 1 || rangeEnd < rangeStart} onClick={() => { setBusy(true); void onAdd(rangeStart, rangeEnd).finally(() => setBusy(false)) }}>{busy ? 'Adding…' : 'Add selection to Context'}</button>
      </div>
    </Modal>
  )
}

function ContextItem({ slice, index, allSlices, onChange, onDelete, onMove }: { slice: ContextSlice; index: number; allSlices: ContextSlice[]; onChange: (args: { enabled?: boolean; wrapper?: WrapperMode; insertAt?: InsertAt }) => Promise<void>; onDelete: () => Promise<void>; onMove: (direction: -1 | 1) => Promise<void> }) {
  const range = slice.range_type === 'all' ? 'Entire file' : slice.range_type === 'lines' ? `Lines ${slice.start_pos}–${slice.end_pos}` : `Chars ${slice.start_pos}–${slice.end_pos}`
  return (
    <div className={`context-item ${slice.enabled ? '' : 'disabled'}`}>
      <div className="context-item-head"><input aria-label="Include context" type="checkbox" checked={slice.enabled} onChange={(event) => void onChange({ enabled: event.target.checked })} /><div className="context-title"><strong>{slice.source_name}</strong><span>{range} · ~{formatTokens(slice.estimated_tokens)}</span></div><button className="icon-button danger" title="Remove slice" onClick={() => void onDelete()}>×</button></div>
      <div className="context-controls">
        <select value={slice.wrapper} onChange={(event) => void onChange({ wrapper: event.target.value as WrapperMode })}><option value="raw">Exact / raw</option><option value="labeled">Labeled</option></select>
        <select value={slice.insert_at} onChange={(event) => void onChange({ insertAt: event.target.value as InsertAt })}><option value="before_current">Before current input</option><option value="inside_current">After current input</option><option value="before_history">Before chat history</option><option value="system">System</option></select>
        <div className="reorder"><button disabled={index === 0} onClick={() => void onMove(-1)}>↑</button><button disabled={index === allSlices.length - 1} onClick={() => void onMove(1)}>↓</button></div>
      </div>
    </div>
  )
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
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [compactLayout] = useState(() => typeof window !== 'undefined' && window.matchMedia(compactLayoutQuery).matches)
  const [threadsOpen, setThreadsOpen] = useState(() => typeof window === 'undefined' || !window.matchMedia(compactLayoutQuery).matches)
  const [contextOpen, setContextOpen] = useState(() => typeof window === 'undefined' || !window.matchMedia(compactLayoutQuery).matches)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const restoreLeafOnErrorRef = useRef<string | null>(null)

  const refreshBootstrap = async () => {
    const next = await bootstrap()
    setState(next)
    setConversationId((current) => current && next.conversations.some((item) => item.id === current) ? current : next.conversations[0]?.id ?? null)
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
        void refreshBootstrap()
      } else if (payload.kind === 'error') {
        setError(payload.error ?? 'Provider request failed')
        if (restoreLeafOnErrorRef.current) setActiveLeafId(restoreLeafOnErrorRef.current)
        restoreLeafOnErrorRef.current = null
        setStreaming(null)
        void refreshBootstrap()
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
  const canCompile = Boolean(conversationId)
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
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  const handlePreview = async () => {
    if (!conversationId || !canCompile) return
    setError(null)
    try { setPreview(await compileRequest(requestArgs())) } catch (reason) { setError(String(reason)) }
  }

  const handleRegenerate = async (assistant: Message) => {
    if (!conversationId || busy || streaming || assistant.role !== "assistant" || !assistant.parent_id) return
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
      setError(String(reason))
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

  if (!state) return <div className="loading">Opening local workspace…</div>

  const providerProtocolLabel = state.provider.protocol === "openai_responses" ? "Responses API" : "Chat Completions"
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
    <div className={`app-shell ${threadsOpen ? "threads-open" : "threads-closed"} ${contextOpen ? "context-open" : "context-closed"}`}>
      {compactLayout && (threadsOpen || contextOpen) && <button className="panel-scrim" aria-label="Close side panel" onClick={() => { setThreadsOpen(false); setContextOpen(false) }} />}
      <aside id="threads-panel" className="sidebar threads-panel">
        <div className="panel-heading"><div><span className="eyebrow">Local</span><h1>CeraChat</h1></div><button className="icon-button" title="Provider settings" onClick={() => setSettingsOpen(true)}>⚙</button></div>
        <button className="new-chat" onClick={() => void createConversation().then(async (conversation) => { await refreshBootstrap(); setConversationId(conversation.id) }).catch((reason) => setError(String(reason)))}>＋ New chat</button>
        <div className="section-label">Threads</div>
        <div className="conversation-list">
          {state.conversations.map((conversation) => <div className={`conversation-row ${conversation.id === conversationId ? 'active' : ''}`} key={conversation.id}><button onClick={() => setConversationId(conversation.id)}><strong>{conversation.title}</strong><span>{shortId(conversation.id)}</span></button><button className="row-delete" title="Delete conversation" onClick={() => { if (confirm('Delete this conversation and its message tree?')) void deleteConversation(conversation.id).then(refreshBootstrap).catch((reason) => setError(String(reason))) }}>×</button></div>)}
        </div>
        <div className="section-label branch-label">Branch tree</div>
        <div className="branch-tree">
          {messages.map((message) => <button key={message.id} className={`branch-node ${message.id === activeLeafId ? 'active' : ''}`} style={{ paddingLeft: `${10 + depthFor(message, byId) * 12}px` }} onClick={() => selectLeaf(message.id)}><span className={`role-dot ${message.role}`} /> <span>{message.content.replace(/\s+/g, ' ').slice(0, 40) || '(empty)'}</span></button>)}
        </div>
        <div className="sidebar-footer"><span>{isTauri() ? 'Desktop' : 'Browser demo'}</span><code title={state.data_dir}>{state.data_dir ? state.data_dir.split(/[\\/]/).slice(-1)[0] : 'local'}</code></div>
      </aside>

      <main className="chat-panel">
        <header className="chat-header">
          <div className="chat-header-main"><button className="panel-toggle" onClick={toggleThreads}>Threads</button><div><span className="eyebrow">{state.provider.name} · {providerProtocolLabel}</span><strong>{state.provider.model}</strong></div></div>
          <div className="chat-header-actions"><button className="panel-toggle" onClick={toggleContext}>Context</button><button className="icon-button" title="Provider settings" onClick={() => setSettingsOpen(true)}>⚙</button><div className="budget-chip"><span>{formatTokens(historyTokens + workspaceTokens + estimateTokens(input))} input</span><small>{formatTokens(workspaceTokens)} workspace</small></div></div>
        </header>
        {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}>×</button></div>}
        <section className="messages">
          {path.length === 0 && <div className="empty-chat"><div className="empty-mark">C</div><h2>One visible request. Everything else stays local.</h2><p>Select local context on the right, inspect the exact request, then send once.</p></div>}
          {path.map((message) => <article className={`message ${message.role}`} key={message.id}><div className="message-meta"><strong>{message.role === 'user' ? 'USER' : 'MODEL'}</strong><span>{shortId(message.id)}</span><label><input type="checkbox" checked={message.include_next} onChange={(event) => { const included = event.target.checked; setMessages((current) => current.map((item) => item.id === message.id ? { ...item, include_next: included } : item)); void setMessageIncluded(message.id, included).catch((reason) => setError(String(reason))) }} /> Include next</label><button onClick={() => void handleCopyMessage(message)}>{copiedMessageId === message.id ? 'Copied' : 'Copy'}</button>{message.role === 'assistant' && <button disabled={busy || Boolean(streaming)} onClick={() => void handleRegenerate(message)}>Regenerate</button>}<button title="Delete this branch" onClick={() => { if (confirm('Delete this message and all descendants?')) void deleteBranch(message.id).then(async () => { if (conversationId) await loadConversation(conversationId); await refreshBootstrap() }).catch((reason) => setError(String(reason))) }}>Delete branch</button></div><MarkdownContent content={message.content} /></article>)}
          {streaming && <article className="message assistant streaming"><div className="message-meta"><strong>MODEL</strong><span>streaming</span></div><MarkdownContent content={streaming.text || '…'} /></article>}
          <div ref={messagesEndRef} />
        </section>
        <section className="composer-wrap">
          <div className="composer-toolbar">
            <label>History<select value={historyMode} onChange={(event) => setHistoryMode(event.target.value as HistoryMode)}><option value="full">Full branch</option><option value="last10">Last 10 messages</option><option value="since_here">Since here</option><option value="selected">Selected messages</option><option value="no_history">No history</option></select></label>
            {historyMode === 'since_here' && <select aria-label="Since message" value={sinceMessageId ?? ''} onChange={(event) => setSinceMessageId(event.target.value || null)}><option value="">Choose message…</option>{path.map((message) => <option value={message.id} key={message.id}>{message.role}: {message.content.slice(0, 45)}</option>)}</select>}
            <span className="token-breakdown">{formatTokens(historyTokens)} history · {formatTokens(workspaceTokens)} workspace · ~{formatTokens(estimateTokens(input))} input</span>
          </div>
          <textarea ref={textareaRef} className="composer" rows={5} placeholder="Message the model…" value={input} onChange={(event) => { if (conversationId) setDrafts((current) => ({ ...current, [conversationId]: event.target.value })) }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void handleSend() } }} />
          <div className="composer-footer"><span className="composer-status"><span>{input.length.toLocaleString()} chars / ~{formatTokens(Math.ceil(input.length / 4))}</span><span>Enter to send · Shift+Enter for a new line</span></span><div><button disabled={!canCompile} onClick={() => void handlePreview()}>Preview request</button><button className="primary" disabled={busy || !canCompile} onClick={() => void handleSend()}>{streaming ? 'Streaming…' : busy ? 'Starting…' : 'Send'}</button></div></div>
        </section>
      </main>

      <aside id="context-panel" className="sidebar context-panel">
        <div className="panel-heading"><div><span className="eyebrow">Local text only</span><h2>Context Workspace</h2></div><button className="icon-button" title="Import files" onClick={() => void handleImport()}>＋</button></div>
        <div className="context-actions"><button onClick={() => void handleImport()}>Add TXT / ZIP</button><button disabled={busy || !state.sources.length} onClick={() => void addAllSources('raw')}>Include all · exact</button><button disabled={busy || !state.sources.length} onClick={() => void addAllSources('labeled')}>Include all · labeled</button></div>
        <div className="section-label">Sources</div>
        <div className="source-list">
          {state.sources.map((source) => <div className="source-row" key={source.id}><button onClick={() => setViewerSource(source)}><span className="source-icon">{source.archive_path ? '▣' : '▤'}</span><span><strong>{source.display_name}</strong><small>{formatBytes(source.original_size)} · {source.line_count.toLocaleString()} lines</small></span></button><div className="source-actions"><button title="Include entire file" onClick={() => void addContextSlice({ sourceId: source.id, rangeType: 'all', wrapper: 'raw', insertAt: 'before_current' }).then(refreshBootstrap).catch((reason) => setError(String(reason)))}>＋</button><button title="Remove source" onClick={() => { if (confirm('Remove this source and its live context slices? Past request snapshots remain reproducible.')) void removeSource(source.id).then(refreshBootstrap).catch((reason) => setError(String(reason))) }}>×</button></div></div>)}
          {!state.sources.length && <p className="muted">Drop-in import is local. ZIP entries are expanded into virtual text sources; unsupported binaries are ignored.</p>}
        </div>
        <div className="section-label compiled-label"><span>Compiled Context</span><strong>~{formatTokens(workspaceTokens)}</strong></div>
        <div className="slice-list">
          {orderedSlices.map((slice, index) => <ContextItem key={slice.id} slice={slice} index={index} allSlices={orderedSlices} onChange={(patch) => updateSlice(slice, patch)} onDelete={async () => { await deleteContextSlice(slice.id); await refreshBootstrap() }} onMove={(direction) => moveSlice(slice, direction)} />)}
          {!orderedSlices.length && <p className="muted">Nothing will be inserted from the workspace until you add a slice.</p>}
        </div>
        <div className="context-total"><span>Total enabled</span><strong>~{formatTokens(workspaceTokens)}</strong></div>
      </aside>

      {settingsOpen && <ProviderSettings provider={state.provider} onClose={() => setSettingsOpen(false)} onSave={async (provider) => { await saveProvider(provider); await refreshBootstrap(); setSettingsOpen(false) }} />}
      {preview && <RequestInspector preview={preview} onClose={() => setPreview(null)} />}
      {viewerSource && <SourceViewer source={viewerSource} onClose={() => setViewerSource(null)} onAdd={async (start, end) => { await addContextSlice({ sourceId: viewerSource.id, rangeType: 'lines', startPos: start, endPos: end, wrapper: 'raw', insertAt: 'before_current' }); await refreshBootstrap(); setViewerSource(null) }} />}
    </div>
  )
}
