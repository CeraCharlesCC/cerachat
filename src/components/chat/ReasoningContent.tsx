import type { Reasoning } from '../../types'
import { MarkdownContent } from './MarkdownContent'

export function ReasoningContent({ reasoning, disabled = true, messageIncluded = true, onIncludedChange }: {
  reasoning?: Reasoning | null
  disabled?: boolean
  messageIncluded?: boolean
  onIncludedChange?: (partId: string, included: boolean) => void
}) {
  if (!reasoning || (!reasoning.parts.length && reasoning.tokens === null && !reasoning.encrypted)) return null
  const summaryOnly = reasoning.parts.length > 0 && reasoning.parts.every((part) => part.kind === 'summary')
  return (
    <details aria-label="Response reasoning" className="mb-3 rounded-xl border border-border/70 text-sm text-muted-foreground">
      <summary className="cursor-pointer rounded-xl px-3 py-2 select-none hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
        {summaryOnly ? 'Reasoning summary' : 'Reasoning'}
        {reasoning.tokens !== null && <> <span className="ml-2 text-xs tabular-nums">{reasoning.tokens.toLocaleString()} tokens</span></>}
      </summary>
      <div className="space-y-3 border-t border-border/70 px-3 py-3">
        {reasoning.parts.length > 0 && <p className="m-0 text-xs">Checked blocks are sent as labeled assistant text in later requests when this message is included in history.</p>}
        {reasoning.parts.map((part) => (
          <div key={part.id}>
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-medium">{part.kind === 'summary' ? 'Summary' : 'Provider reasoning text'}</span>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" aria-label={`Include ${part.kind === 'summary' ? 'reasoning summary' : 'reasoning text'} in next request`} checked={Boolean(part.include_next)} disabled={disabled || !messageIncluded || !part.text || !onIncludedChange} onChange={(event) => onIncludedChange?.(part.id, event.target.checked)} />
                {part.include_next ? 'Included' : 'Include next'}
              </label>
            </div>
            <MarkdownContent content={part.text} />
          </div>
        ))}
        {!reasoning.parts.length && <p className="m-0 text-xs">The provider did not return visible reasoning text.</p>}
        {!messageIncluded && reasoning.parts.length > 0 && <p className="m-0 text-xs">Include this message in history to send its checked reasoning blocks.</p>}
        {reasoning.encrypted && <p className="m-0 text-xs">The provider also returned protected reasoning that cannot be displayed or included.</p>}
      </div>
    </details>
  )
}
