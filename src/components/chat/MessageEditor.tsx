import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { Message, Reasoning, ReasoningReplayMode } from '../../types'
import { ImageAttachments } from './ImageAttachments'
import { Button } from '../ui/Button'

export function MessageEditor({ message, onSave, onCancel }: {
  message: Message
  onSave: (content: string, reasoning?: Reasoning | null) => Promise<void>
  onCancel: () => void
}) {
  const [content, setContent] = useState(message.content)
  const [reasoning, setReasoning] = useState<Reasoning>(structuredClone(message.reasoning ?? { parts: [], tokens: null, encrypted: false }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const hintId = useId()
  const errorId = useId()
  const reasoningChanged = JSON.stringify(reasoning) !== JSON.stringify(message.reasoning ?? { parts: [], tokens: null, encrypted: false })
  const canSave = !busy && (Boolean(content.trim()) || Boolean(message.images?.length) || reasoning.parts.some((part) => part.text.trim())) && (content !== message.content || reasoningChanged)

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [content])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    textarea?.focus({ preventScroll: true })
    textarea?.setSelectionRange(textarea.value.length, textarea.value.length)
  }, [])

  const save = async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try { await onSave(content, message.role === 'assistant' ? reasoning : undefined) } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }

  return (
    <form aria-label="Edit message" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void save() }} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void save() }
      if (event.key === 'Escape') { event.preventDefault(); if (!busy) onCancel() }
    }} className="flex w-full min-w-0 flex-col gap-3 rounded-2xl border border-ring/60 bg-muted p-3 text-foreground focus-within:ring-2 focus-within:ring-ring/20">
      <ImageAttachments images={message.images ?? []} />
      <textarea
        ref={textareaRef}
        aria-label="Edited message"
        aria-describedby={`${hintId}${error ? ` ${errorId}` : ''}`}
        className="block max-h-[50dvh] min-h-24 w-full resize-none overflow-y-auto bg-transparent px-1 py-1 text-[15px] leading-[1.8] outline-none"
        rows={2}
        value={content}
        readOnly={busy}
        onChange={(event) => setContent(event.target.value)}
      />
      {message.role === 'assistant' && <fieldset disabled={busy} className="min-w-0 space-y-3 rounded-xl border border-border p-3">
        <legend className="px-1 text-sm font-medium">Reasoning blocks</legend>
        <label className="block text-xs">Reasoning replay
          <select aria-label="Reasoning replay" className="mt-1 block w-full rounded border border-border bg-background p-2 text-sm" value={reasoning.replay_mode ?? 'native'} onChange={(event) => setReasoning({ ...reasoning, replay_mode: event.target.value as ReasoningReplayMode })}>
            <option value="native">Native raw (DeepSeek / Kimi / GLM)</option>
            <option value="interleaved">Interleaved mock (next intervention as tool result)</option>
            <option value="text">Assistant notes (text compatibility)</option>
          </select>
        </label>
        <p className="m-0 text-xs text-muted-foreground">Native raw requires a provider that accepts plaintext reasoning. Summaries remain notes. Interleaved mock requires raw text and tool support. Provider preservation settings still apply.</p>
        {reasoning.parts.map((part, index) => <div key={part.id} className="space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span>{part.kind === 'text' ? 'Raw reasoning' : 'Summary'} {index + 1}</span>
            <label className="flex items-center gap-1"><input type="checkbox" aria-label={`Include edited reasoning block ${index + 1}`} checked={Boolean(part.include_next)} onChange={(event) => setReasoning({ ...reasoning, parts: reasoning.parts.map((p) => p.id === part.id ? { ...p, include_next: event.target.checked } : p) })} />Include next</label>
            <button type="button" className="underline" onClick={() => setReasoning({ ...reasoning, parts: reasoning.parts.filter((p) => p.id !== part.id) })}>Remove block {index + 1}</button>
          </div>
          <textarea aria-label={`Edited reasoning block ${index + 1}`} className="block min-h-24 w-full resize-y rounded border border-border bg-background p-2 text-sm" value={part.text} onChange={(event) => setReasoning({ ...reasoning, parts: reasoning.parts.map((p) => p.id === part.id ? { ...p, text: event.target.value } : p) })} />
        </div>)}
        <Button size="sm" variant="outline" onClick={() => setReasoning({ ...reasoning, parts: [...reasoning.parts, { id: crypto.randomUUID(), kind: 'text', text: '', include_next: true }] })}>Add raw reasoning block</Button>
        <p className="m-0 text-xs text-muted-foreground">Editing creates an experimental reasoning branch; providers may ignore modified reasoning or produce different results. Protected state is never fabricated.</p>
      </fieldset>}
      <p id={hintId} className="m-0 px-1 text-xs leading-5 text-muted-foreground">Saves a new branch. Original messages and replies are kept. No request is sent.</p>
      {error && <p id={errorId} className="m-0 px-1 text-sm text-destructive" role="alert">{error}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto px-1 text-[11px] text-muted-foreground">Esc to cancel · ⌘/Ctrl+Enter to save</span>
        <Button variant="outline" size="sm" className="rounded-full" disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" size="sm" className="rounded-full" disabled={!canSave}>{busy ? 'Saving…' : 'Save as new branch'}</Button>
      </div>
    </form>
  )
}
