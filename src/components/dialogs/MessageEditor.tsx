import { useState } from 'react'
import type { Message } from '../../types'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'

export function MessageEditor({ message, onSave, onClose }: {
  message: Message
  onSave: (content: string) => Promise<void>
  onClose: () => void
}) {
  const [content, setContent] = useState(message.content)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    if (busy || !content.trim() || content === message.content) return
    setBusy(true)
    setError(null)
    try { await onSave(content) } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  return (
    <Modal title="Edit message" onClose={() => { if (!busy) onClose() }} wide footer={<>
      <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={busy || !content.trim() || content === message.content} onClick={() => void save()}>{busy ? 'Saving…' : 'Save as new branch'}</Button>
    </>}>
      <p className="mt-0 text-sm text-muted-foreground">Your original message and its replies stay in their branch. Saving creates a new branch without sending a request.</p>
      <textarea autoFocus aria-label="Edited message" className="field min-h-64 resize-y font-mono text-sm" value={content} disabled={busy} onChange={(event) => setContent(event.target.value)} onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void save() }
        if (event.key === 'Escape' && !busy) onClose()
      }} />
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    </Modal>
  )
}
