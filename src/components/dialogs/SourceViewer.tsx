import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AddSliceArgs, InsertAt, SourceLines, WorkspaceSource, WrapperMode } from '../../types'
import { formatBytes } from '../../lib/utils'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'

export function SourceViewer({ source, wrapper: initialWrapper, insertAt: initialInsertAt, onClose, onLoadLines, onAdd }: {
  source: WorkspaceSource
  wrapper: WrapperMode
  insertAt: InsertAt
  onClose: () => void
  onLoadLines: (sourceId: string, start: number, count?: number) => Promise<SourceLines>
  onAdd: (args: AddSliceArgs) => Promise<void>
}) {
  const [windowStart, setWindowStart] = useState(1)
  const [lines, setLines] = useState<SourceLines | null>(null)
  const [rangeType, setRangeType] = useState<'all' | 'lines'>('all')
  const [rangeStart, setRangeStart] = useState(1)
  const [rangeEnd, setRangeEnd] = useState(Math.max(1, source.line_count))
  const [wrapper, setWrapper] = useState(initialWrapper)
  const [insertAt, setInsertAt] = useState(initialInsertAt)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const validRange = Number.isInteger(rangeStart) && Number.isInteger(rangeEnd) && rangeStart >= 1 && rangeEnd >= rangeStart && rangeEnd <= source.line_count

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setLines(null)
    void onLoadLines(source.id, windowStart, 200)
      .then((result) => { if (!cancelled) setLines(result) })
      .catch((reason) => { if (!cancelled) setError(String(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [onLoadLines, source.id, windowStart, retry])

  const add = async () => {
    setBusy(true)
    setError(null)
    try {
      await onAdd({ sourceId: source.id, rangeType, ...(rangeType === 'lines' ? { startPos: rangeStart, endPos: rangeEnd } : {}), wrapper, insertAt })
    } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  return (
    <Modal title={source.display_name} onClose={() => { if (!busy) onClose() }} wide footer={<>
      <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={busy || (rangeType === 'lines' && !validRange)} onClick={() => void add()}>{busy ? 'Adding…' : 'Add to context'}</Button>
    </>}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{source.line_count.toLocaleString()} lines · {formatBytes(source.original_size)}</span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" aria-label="Previous 200 lines" disabled={loading || windowStart <= 1} onClick={() => setWindowStart(Math.max(1, windowStart - 200))}><ChevronLeft size={14} /></Button>
          <span className="tabular-nums">{source.line_count ? `${windowStart}–${Math.min(windowStart + 199, source.line_count)}` : 'Empty file'}</span>
          <Button variant="outline" size="sm" aria-label="Next 200 lines" disabled={loading || windowStart + 200 > source.line_count} onClick={() => setWindowStart(windowStart + 200)}><ChevronRight size={14} /></Button>
        </div>
      </div>
      <div className="scroll-stable h-[40dvh] overflow-auto rounded-xl border border-border/60 bg-muted/20">
        {loading && <p className="px-3 text-sm text-muted-foreground" role="status">Loading…</p>}
        {lines?.lines.map((line, index) => (
          <div className="grid min-h-5 grid-cols-[8ch_1fr] font-mono text-xs leading-5 hover:bg-muted/60" key={lines.start_line + index}>
            <button className="select-none tabular-nums border-r border-border/60 pr-2 text-right text-muted-foreground hover:text-primary" title="Start selection here; Shift-click to set end" onClick={(event) => {
              const lineNumber = lines.start_line + index
              setRangeType('lines')
              if (event.shiftKey) { setRangeEnd(Math.max(rangeStart, lineNumber)) }
              else { setRangeStart(lineNumber); setRangeEnd(lineNumber) }
            }}>{lines.start_line + index}</button>
            <code className="overflow-visible whitespace-pre px-2">{line.replace(/\r$/, '') || ' '}</code>
          </div>
        ))}
      </div>
      {error && <div className="mt-2 text-sm text-destructive" role="alert">{error}{!lines && <Button variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>Retry</Button>}</div>}
      <div className="mt-3 grid grid-cols-3 items-end gap-2 max-sm:grid-cols-2">
        <label className="field-label">Include<select aria-label="Include" className="field mt-1" value={rangeType} onChange={(event) => setRangeType(event.target.value as 'all' | 'lines')}><option value="all">Entire file</option><option value="lines">Line range</option></select></label>
        <label className="field-label">Format<select aria-label="Format" className="field mt-1" value={wrapper} onChange={(event) => setWrapper(event.target.value as WrapperMode)}><option value="raw">Exact text</option><option value="labeled">File labels</option></select></label>
        <label className="field-label">Position<select aria-label="Position" className="field mt-1" value={insertAt} onChange={(event) => setInsertAt(event.target.value as InsertAt)}><option value="inside_current">After input</option><option value="before_current">Before input</option><option value="before_history">Before history</option><option value="system">System</option></select></label>
        {rangeType === 'lines' && <>
          <label className="field-label">From line<input className="field mt-1 tabular-nums" type="number" min={1} max={source.line_count} value={rangeStart} onChange={(event) => setRangeStart(Number(event.target.value))} /></label>
          <label className="field-label">To line<input className="field mt-1 tabular-nums" type="number" min={rangeStart} max={source.line_count} value={rangeEnd} onChange={(event) => setRangeEnd(Number(event.target.value))} /></label>
          <Button variant="outline" size="sm" disabled={!validRange} onClick={() => setWindowStart(Math.floor((rangeStart - 1) / 200) * 200 + 1)}>Show selection</Button>
          {!validRange && <p className="col-span-full m-0 text-xs text-destructive">Enter a valid range between 1 and {source.line_count}.</p>}
        </>}
      </div>
    </Modal>
  )
}
