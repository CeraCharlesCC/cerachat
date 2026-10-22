import { FileText, FolderPlus, GripVertical, ClipboardPaste, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { ContextSlice, InsertAt, WorkspaceSource, WrapperMode } from '../../types'
import { formatBytes, formatTokens } from '../../lib/utils'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { ContextItem } from './ContextItem'

type ContextSidebarProps = {
  open: boolean
  sources: WorkspaceSource[]
  slices: ContextSlice[]
  workspaceTokens: number
  busy: boolean
  wrapper: WrapperMode
  insertAt: InsertAt
  autoInclude: boolean
  onWrapperChange: (wrapper: WrapperMode) => void
  onInsertAtChange: (insertAt: InsertAt) => void
  onAutoIncludeChange: (enabled: boolean) => void
  onImport: () => void
  onPaste: () => void
  onAddAll: () => void
  onOpenSource: (source: WorkspaceSource) => void
  onAddSource: (source: WorkspaceSource) => void
  onRemoveSource: (source: WorkspaceSource) => void
  onChangeSlice: (slice: ContextSlice, patch: { enabled?: boolean; wrapper?: WrapperMode; insertAt?: InsertAt }) => void
  onDeleteSlice: (slice: ContextSlice) => void
  onMoveSlice: (slice: ContextSlice, direction: -1 | 1) => void
  onReorder: (draggedId: string, targetId: string) => void
}

export function ContextSidebar({ open, sources, slices, workspaceTokens, busy, wrapper, insertAt, autoInclude, onWrapperChange, onInsertAtChange, onAutoIncludeChange, onImport, onPaste, onAddAll, onOpenSource, onAddSource, onRemoveSource, onChangeSlice, onDeleteSlice, onMoveSlice, onReorder }: ContextSidebarProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [targetId, setTargetId] = useState<string | null>(null)
  return (
    <aside id="context-panel" className={`panel flex min-h-0 min-w-0 flex-col border-l border-border/60 max-[1100px]:fixed max-[1100px]:inset-y-0 max-[1100px]:right-0 max-[1100px]:z-40 max-[1100px]:w-[min(380px,92vw)] max-[1100px]:shadow-[var(--shadow)] max-[1100px]:transition-transform ${open ? 'max-[1100px]:translate-x-0' : 'max-[1100px]:invisible max-[1100px]:translate-x-[105%]'}`}>
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-border/60 px-4">
        <h2 className="m-0 text-base font-semibold tracking-tight">Context</h2>
        <span className="text-xs tabular-nums text-muted-foreground">{slices.filter((slice) => slice.enabled).length} included · ~{formatTokens(workspaceTokens)}</span>
      </header>
      <div className="space-y-2 border-b border-border/60 p-3">
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={onImport}><FolderPlus size={15} /> Add files</Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={onPaste}><ClipboardPaste size={15} /> Paste text</Button>
        </div>
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">New attachment options</summary>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-[11px] text-muted-foreground">Format<select aria-label="New attachment format" className="field mt-1 text-xs" value={wrapper} onChange={(event) => onWrapperChange(event.target.value as WrapperMode)}><option value="raw">Exact text</option><option value="labeled">File labels</option></select></label>
            <label className="text-[11px] text-muted-foreground">Insert<select aria-label="New attachment position" className="field mt-1 text-xs" value={insertAt} onChange={(event) => onInsertAtChange(event.target.value as InsertAt)}><option value="inside_current">After input</option><option value="before_current">Before input</option><option value="before_history">Before history</option><option value="system">System</option></select></label>
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={autoInclude} onChange={(event) => onAutoIncludeChange(event.target.checked)} /> Include imported files automatically</label>
        </details>
      </div>
      <details className="shrink-0 border-b border-border/60" open>
        <summary className="cursor-pointer px-4 py-2.5 text-xs font-medium">Source library <span className="text-muted-foreground">({sources.length})</span></summary>
        <div className="max-h-[22vh] scroll-stable overflow-y-auto px-2 pb-2">
          {sources.map((source) => {
            const included = slices.some((slice) => slice.source_id === source.id && slice.enabled)
            return <div key={source.id} className="flex items-center rounded-lg hover:bg-muted">
              <button className="flex min-w-0 flex-1 items-center gap-2 p-2 text-left" title={source.origin_path} onClick={() => onOpenSource(source)}>
                <FileText className="shrink-0 text-muted-foreground" size={14} />
                <span className="min-w-0 flex-1"><strong className="block truncate text-xs font-medium">{source.display_name}</strong><small className="mt-0.5 block text-[10px] text-muted-foreground">{formatBytes(source.original_size)} · {source.line_count.toLocaleString()} lines{included ? ' · Included' : ''}</small></span>
              </button>
              <IconButton className="size-7" disabled={busy} aria-label={`Include all of ${source.display_name}`} title="Include entire file" onClick={() => onAddSource(source)}><Plus size={14} /></IconButton>
              <IconButton className="size-7" disabled={busy} variant="destructive" aria-label={`Remove ${source.display_name}`} title="Remove source" onClick={() => onRemoveSource(source)}><Trash2 size={14} /></IconButton>
            </div>
          })}
          {sources.length === 0 && <p className="m-0 px-2 py-2 text-xs text-muted-foreground">Add text files, a ZIP, or paste text.</p>}
          {sources.length > 0 && <Button variant="ghost" size="sm" className="mt-1 w-full" disabled={busy} onClick={onAddAll}>Include all sources</Button>}
        </div>
      </details>
      <div className="px-4 pt-3 pb-2">
        <h3 className="m-0 text-xs font-medium">Attachment order</h3>
        <p className="mb-0 mt-1 text-[11px] leading-4 text-muted-foreground">Drag the grip or use arrows to reorder. Items at the same insertion point are joined in this order using the provider separator.</p>
      </div>
      <div className="min-h-0 flex-1 space-y-2 scroll-stable overflow-y-auto px-3 pb-3" role="list" aria-label="Ordered attachments">
        {slices.map((slice, index) => <div key={slice.id} role="listitem"
          className={`relative rounded-xl ${targetId === slice.id && draggedId !== slice.id ? 'ring-2 ring-primary' : ''} ${draggedId === slice.id ? 'opacity-50' : ''}`}
          onDragOver={(event) => { if (!busy && draggedId) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setTargetId(slice.id) } }}
          onDrop={(event) => { event.preventDefault(); if (!busy && draggedId && draggedId !== slice.id) onReorder(draggedId, slice.id); setDraggedId(null); setTargetId(null) }}>
          <ContextItem slice={slice} index={index} count={slices.length} disabled={busy}
            dragHandle={<span draggable={!busy} title="Drag to reorder attachment" aria-label={`Drag attachment ${index + 1}`} className="flex shrink-0 cursor-grab items-center text-muted-foreground active:cursor-grabbing"
              onDragStart={(event) => { event.dataTransfer.setData('text/plain', slice.id); event.dataTransfer.effectAllowed = 'move'; setDraggedId(slice.id) }}
              onDragEnd={() => { setDraggedId(null); setTargetId(null) }}><GripVertical size={15} /><span className="w-4 text-[10px] tabular-nums">{index + 1}</span></span>}
            onInspect={() => { const source = sources.find((item) => item.id === slice.source_id); if (source) onOpenSource(source) }}
            onChange={(patch) => onChangeSlice(slice, patch)} onDelete={() => onDeleteSlice(slice)} onMove={(direction) => onMoveSlice(slice, direction)} />
        </div>)}
        {slices.length === 0 && <div className="rounded-xl border border-dashed border-border p-5 text-center text-xs leading-5 text-muted-foreground">Your attachments appear here.<br />Add files or paste text to get started.</div>}
      </div>
    </aside>
  )
}
