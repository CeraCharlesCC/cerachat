import { useState } from 'react'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'

export function TextSourceDialog({ onAdd, onClose }: { onAdd: (name: string, text: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState('pasted.txt')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Modal title="Paste text" onClose={() => { if (!busy) onClose() }} wide footer={<>
      <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={busy || !name.trim() || !text.trim()} onClick={() => {
        setBusy(true)
        setError(null)
        void onAdd(name, text).catch((reason) => setError(String(reason))).finally(() => setBusy(false))
      }}>{busy ? 'Adding…' : 'Add text'}</Button>
    </>}>
      <label className="field-label">File name<input autoFocus className="field mt-1 mb-3" value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="field-label">Text<textarea className="field mt-1 min-h-64 resize-y font-mono" value={text} onChange={(event) => setText(event.target.value)} /></label>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    </Modal>
  )
}
