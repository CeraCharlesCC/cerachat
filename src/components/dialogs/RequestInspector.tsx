import type { RequestPreview } from '../../types'
import { formatTokens } from '../../lib/utils'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'

export function RequestInspector({ preview, onClose }: { preview: RequestPreview; onClose: () => void }) {
  const b = preview.breakdown
  const items = [
    ['System', b.system_tokens],
    ['History', b.history_tokens],
    ['Workspace', b.workspace_tokens],
    ['Current input', b.input_tokens],
    ['Estimated input', b.estimated_input_tokens],
    ['Max output', b.max_output_tokens],
    ['Configured context', b.configured_context],
  ] as const

  return (
    <Modal title="Request preview" onClose={onClose} wide>
      <div className="mb-4 grid grid-cols-4 gap-2 max-lg:grid-cols-3 max-sm:grid-cols-2">
        {items.map(([label, value]) => (
          <div key={label} className={`rounded-lg border px-2.5 py-2 ${label === 'Estimated input' ? 'border-border bg-muted' : 'border-border/60 bg-background'}`}>
            <span className="block text-[10px] text-muted-foreground">{label}</span>
            <strong className="mt-0.5 block text-xs font-semibold">{formatTokens(value)}</strong>
          </div>
        ))}
      </div>
      <div className="mb-4 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 max-sm:grid-cols-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">SHA-256</span>
        <code className="min-w-0 truncate font-mono text-[10px]">{preview.request_sha256}</code>
        <Button variant="outline" size="sm" onClick={() => void navigator.clipboard?.writeText(preview.request_json)}>Copy JSON</Button>
      </div>
      <h3 className="mb-1.5 mt-0 text-xs font-semibold">Actual request JSON</h3>
      <pre className="max-h-[42vh] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border/60 bg-muted/40 p-3 font-mono text-[10px] leading-5">{preview.request_json}</pre>
      <details className="mt-3">
        <summary className="cursor-pointer text-[11px] text-muted-foreground">Compiled prompt audit view</summary>
        <pre className="mt-2 max-h-[42vh] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border/60 bg-muted/40 p-3 font-mono text-[10px] leading-5">{preview.compiled_prompt}</pre>
      </details>
    </Modal>
  )
}
