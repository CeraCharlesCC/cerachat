import { useState } from 'react'
import type { Conversation, WorkspaceSource } from '../../types'
import { formatBytes } from '../../lib/utils'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'

export function ReferenceSourceDialog({ sources, conversations, onAdd, onClose }: {
  sources: WorkspaceSource[]
  conversations: Conversation[]
  onAdd: (source: WorkspaceSource) => Promise<void>
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chatName = (source: WorkspaceSource) => source.conversation_id === null
    ? 'Previous shared library'
    : conversations.find((chat) => chat.id === source.conversation_id)?.title ?? 'Other chat'
  const matches = sources.filter((source) => `${chatName(source)} ${source.display_name}`.toLowerCase().includes(query.toLowerCase()))
  return (
    <Modal title="Add from another chat" onClose={() => { if (!busy) onClose() }}>
      <p className="mt-0 text-sm text-muted-foreground">Choose a source to add to this chat. Each chat keeps its own library and attachment settings.</p>
      <label className="field-label">Search chats and sources<input autoFocus className="field mb-3 mt-1" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="space-y-2">
        {matches.map((source) => (
          <div key={source.id} className="flex items-center gap-3 rounded-xl border border-border p-3">
            <div className="min-w-0 flex-1">
              <p className="m-0 truncate text-xs text-muted-foreground">{chatName(source)}</p>
              <p className="my-1 break-words text-sm font-medium">{source.display_name}</p>
              <small className="text-muted-foreground">{formatBytes(source.original_size)} · {source.line_count.toLocaleString()} lines</small>
            </div>
            <Button variant="outline" size="sm" disabled={busy} aria-label={`Add ${source.display_name} from ${chatName(source)}`} onClick={() => {
              setBusy(true)
              setError(null)
              void onAdd(source).catch((reason) => setError(String(reason))).finally(() => setBusy(false))
            }}>Add to this chat</Button>
          </div>
        ))}
        {matches.length === 0 && <p className="text-sm text-muted-foreground">{sources.length === 0 ? 'No sources in other chats yet.' : 'No matching sources.'}</p>}
      </div>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    </Modal>
  )
}
