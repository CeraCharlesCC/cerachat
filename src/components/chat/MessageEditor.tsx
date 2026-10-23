import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { Message } from '../../types'
import { Button } from '../ui/Button'

export function MessageEditor({ message, onSave, onCancel }: {
  message: Message
  onSave: (content: string) => Promise<void>
  onCancel: () => void
}) {
  const [content, setContent] = useState(message.content)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const hintId = useId()
  const errorId = useId()
  const canSave = !busy && Boolean(content.trim()) && content !== message.content

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
    try { await onSave(content) } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }

  return (
    <form aria-label="Edit message" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void save() }} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void save() }
      if (event.key === 'Escape') { event.preventDefault(); if (!busy) onCancel() }
    }} className="flex w-full min-w-0 flex-col gap-3 rounded-2xl border border-ring/60 bg-muted p-3 text-foreground focus-within:ring-2 focus-within:ring-ring/20">
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
