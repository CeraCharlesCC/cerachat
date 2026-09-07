import { Archive, FileText, FolderPlus, Plus, Trash2 } from 'lucide-react'
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
  onImport: () => void
  onAddAll: (wrapper: WrapperMode) => void
  onOpenSource: (source: WorkspaceSource) => void
  onAddSource: (source: WorkspaceSource) => void
  onRemoveSource: (source: WorkspaceSource) => void
  onChangeSlice: (slice: ContextSlice, patch: { enabled?: boolean; wrapper?: WrapperMode; insertAt?: InsertAt }) => void
  onDeleteSlice: (slice: ContextSlice) => void
  onMoveSlice: (slice: ContextSlice, direction: -1 | 1) => void
}

export function ContextSidebar({
  open,
  sources,
  slices,
  workspaceTokens,
  busy,
  onImport,
  onAddAll,
  onOpenSource,
  onAddSource,
  onRemoveSource,
  onChangeSlice,
  onDeleteSlice,
  onMoveSlice,
}: ContextSidebarProps) {
  return (
    <aside
      id="context-panel"
      className={`flex min-h-0 min-w-0 flex-col border-l border-border/60 bg-card max-[1100px]:fixed max-[1100px]:inset-y-0 max-[1100px]:right-0 max-[1100px]:z-40 max-[1100px]:w-[min(360px,88vw)] max-[1100px]:shadow-[var(--shadow)] max-[1100px]:transition-transform ${open ? 'max-[1100px]:translate-x-0' : 'max-[1100px]:translate-x-[105%]'}`}
    >
      <header className="flex min-h-16 items-center justify-between border-b border-border/60 px-3.5">
        <div className="min-w-0">
          <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Local text only</span>
          <h2 className="m-0 truncate text-base font-semibold tracking-tight">Context</h2>
        </div>
        <IconButton aria-label="Import files" title="Import files" onClick={onImport}><FolderPlus size={16} /></IconButton>
      </header>

      <div className="grid grid-cols-2 gap-1.5 px-2 pt-2">
        <Button variant="outline" size="sm" className="col-span-2 justify-start" onClick={onImport}><Plus size={14} /> Add TXT / ZIP</Button>
        <Button variant="ghost" size="sm" disabled={busy || sources.length === 0} onClick={() => onAddAll('raw')}>All exact</Button>
        <Button variant="ghost" size="sm" disabled={busy || sources.length === 0} onClick={() => onAddAll('labeled')}>All labeled</Button>
      </div>

      <div className="px-3 pb-1 pt-3 text-[11px] font-medium text-muted-foreground">Sources</div>
      <div className="max-h-[31vh] overflow-y-auto px-2 pb-2">
        {sources.map((source) => (
          <div key={source.id} className="group/source flex min-h-9 items-center rounded-md hover:bg-muted">
            <button className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left" onClick={() => onOpenSource(source)}>
              {source.archive_path ? <Archive className="shrink-0 text-muted-foreground" size={14} /> : <FileText className="shrink-0 text-muted-foreground" size={14} />}
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-[11px] font-medium">{source.display_name}</strong>
                <small className="mt-0.5 block truncate text-[9px] text-muted-foreground">{formatBytes(source.original_size)} · {source.line_count.toLocaleString()} lines</small>
              </span>
            </button>
            <div className="mr-1 flex opacity-0 group-hover/source:opacity-100 group-focus-within/source:opacity-100">
              <IconButton className="size-7" aria-label={`Include all of ${source.display_name}`} title="Include entire file" onClick={() => onAddSource(source)}><Plus size={14} /></IconButton>
              <IconButton className="size-7" variant="destructive" aria-label={`Remove ${source.display_name}`} title="Remove source" onClick={() => onRemoveSource(source)}><Trash2 size={14} /></IconButton>
            </div>
          </div>
        ))}
        {sources.length === 0 && <p className="m-0 px-2 py-1 text-[10px] leading-5 text-muted-foreground">Drop-in import is local. ZIP entries are expanded into virtual text sources; unsupported binaries are ignored.</p>}
      </div>

      <div className="flex items-center justify-between border-t border-border/60 px-3 pb-1 pt-3 text-[11px] font-medium text-muted-foreground">
        <span>Compiled context</span>
        <strong className="font-medium text-foreground">~{formatTokens(workspaceTokens)}</strong>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
        {slices.map((slice, index) => (
          <ContextItem
            key={slice.id}
            slice={slice}
            index={index}
            count={slices.length}
            onChange={(patch) => onChangeSlice(slice, patch)}
            onDelete={() => onDeleteSlice(slice)}
            onMove={(direction) => onMoveSlice(slice, direction)}
          />
        ))}
        {slices.length === 0 && <p className="m-0 px-2 py-1 text-[10px] leading-5 text-muted-foreground">Nothing will be inserted from the workspace until you add a slice.</p>}
      </div>
      <footer className="flex items-center justify-between border-t border-border/60 px-3 py-2 text-[11px]">
        <span className="text-muted-foreground">Total enabled</span>
        <strong className="font-medium">~{formatTokens(workspaceTokens)}</strong>
      </footer>
    </aside>
  )
}
