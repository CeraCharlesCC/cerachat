import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SourceLines, WorkspaceSource } from '../../types'
import { formatBytes } from '../../lib/utils'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'

export function SourceViewer({ source, onClose, onLoadLines, onAdd }: {
  source: WorkspaceSource
  onClose: () => void
  onLoadLines: (sourceId: string, start: number, count?: number) => Promise<SourceLines>
  onAdd: (start: number, end: number) => Promise<void>
}) {
  const [windowStart, setWindowStart] = useState(1)
  const [lines, setLines] = useState<SourceLines | null>(null)
  const [rangeStart, setRangeStart] = useState(1)
  const [rangeEnd, setRangeEnd] = useState(Math.min(source.line_count || 1, 200))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void onLoadLines(source.id, windowStart, 200).then((result) => { if (!cancelled) setLines(result) })
    return () => { cancelled = true }
  }, [onLoadLines, source.id, windowStart])

  const numberInputClass = 'field mt-1 tabular-nums'

  return (
    <Modal title={source.display_name} onClose={onClose} wide>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{source.line_count.toLocaleString()} lines · {formatBytes(source.original_size)}</span>
        <div className="flex gap-1">
          <Button variant="outline" size="sm" aria-label="Previous 200 lines" disabled={windowStart <= 1} onClick={() => setWindowStart(Math.max(1, windowStart - 200))}><ChevronLeft size={14} /> 200</Button>
          <Button variant="outline" size="sm" aria-label="Next 200 lines" disabled={windowStart + 200 > source.line_count} onClick={() => setWindowStart(windowStart + 200)}>200 <ChevronRight size={14} /></Button>
        </div>
      </div>
      <div className="scroll-stable h-[45dvh] overflow-auto rounded-xl border border-border/60 bg-muted/20">
        {lines?.lines.map((line, index) => (
          <div className="grid min-h-5 grid-cols-[8ch_1fr] font-mono text-xs leading-5 hover:bg-muted/60" key={lines.start_line + index}>
            <span className="select-none tabular-nums border-r border-border/60 pr-2 text-right text-muted-foreground">{lines.start_line + index}</span>
            <code className="overflow-visible whitespace-pre px-2">{line || ' '}</code>
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-[120px_120px_1fr] items-end gap-2 max-sm:grid-cols-2">
        <label className="text-xs text-muted-foreground">From line<input className={numberInputClass} type="number" min={1} max={source.line_count} value={rangeStart} onChange={(event) => setRangeStart(Number(event.target.value))} /></label>
        <label className="text-xs text-muted-foreground">To line<input className={numberInputClass} type="number" min={rangeStart} max={source.line_count} value={rangeEnd} onChange={(event) => setRangeEnd(Number(event.target.value))} /></label>
        <Button className="min-w-44 justify-self-end max-sm:col-span-2" variant="primary" disabled={busy || rangeStart < 1 || rangeEnd < rangeStart} onClick={() => { setBusy(true); void onAdd(rangeStart, rangeEnd).finally(() => setBusy(false)) }}>{busy ? 'Adding…' : 'Add to context'}</Button>
      </div>
    </Modal>
  )
}
