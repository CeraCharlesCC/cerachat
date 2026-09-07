import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react'
import type { ContextSlice, InsertAt, WrapperMode } from '../../types'
import { formatTokens } from '../../lib/utils'
import { IconButton } from '../ui/IconButton'

type ContextItemProps = {
  slice: ContextSlice
  index: number
  count: number
  onChange: (args: { enabled?: boolean; wrapper?: WrapperMode; insertAt?: InsertAt }) => void
  onDelete: () => void
  onMove: (direction: -1 | 1) => void
}

export function ContextItem({ slice, index, count, onChange, onDelete, onMove }: ContextItemProps) {
  const range = slice.range_type === 'all'
    ? 'Entire file'
    : slice.range_type === 'lines'
      ? `Lines ${slice.start_pos}–${slice.end_pos}`
      : `Chars ${slice.start_pos}–${slice.end_pos}`

  return (
    <div className={`rounded-xl border border-border/60 p-2.5 ${slice.enabled ? 'bg-card' : 'bg-muted/40'}`}>
      <div className="flex items-start gap-2">
        <input
          className="mt-1 accent-primary"
          aria-label="Include context"
          type="checkbox"
          checked={slice.enabled}
          onChange={(event) => onChange({ enabled: event.target.checked })}
        />
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-xs font-medium" title={slice.source_name}>{slice.source_name}</strong>
          <span className="mt-0.5 block truncate tabular-nums text-[11px] text-muted-foreground">{range} · ~{formatTokens(slice.estimated_tokens)}</span>
        </div>
        <IconButton className="size-7" variant="destructive" aria-label="Remove context slice" title="Remove slice" onClick={onDelete}>
          <Trash2 size={14} />
        </IconButton>
      </div>

      <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-1.5">
        <select
          className="col-span-2 h-8 min-w-0 rounded-md border border-border/70 bg-background px-1.5 text-[11px] hover:bg-accent"
          value={slice.wrapper}
          aria-label="Context wrapper"
          onChange={(event) => onChange({ wrapper: event.target.value as WrapperMode })}
        >
          <option value="raw">Exact / raw</option>
          <option value="labeled">Labeled</option>
        </select>
        <select
          className="h-7 min-w-0 rounded-md border border-border/70 bg-background px-1.5 text-[11px] hover:bg-accent"
          value={slice.insert_at}
          aria-label="Context insertion point"
          onChange={(event) => onChange({ insertAt: event.target.value as InsertAt })}
        >
          <option value="before_current">Before current input</option>
          <option value="inside_current">After current input</option>
          <option value="before_history">Before chat history</option>
          <option value="system">System</option>
        </select>
        <div className="flex">
          <IconButton className="size-7 rounded-md" aria-label="Move context slice up" disabled={index === 0} onClick={() => onMove(-1)}><ChevronUp size={13} /></IconButton>
          <IconButton className="size-7 rounded-md" aria-label="Move context slice down" disabled={index === count - 1} onClick={() => onMove(1)}><ChevronDown size={13} /></IconButton>
        </div>
      </div>
    </div>
  )
}
