import type { Reasoning } from '../../types'
import { MarkdownContent } from './MarkdownContent'

export function ReasoningContent({ reasoning }: { reasoning?: Reasoning | null }) {
  if (!reasoning || (!reasoning.parts.length && reasoning.tokens === null && !reasoning.encrypted)) return null
  const summaryOnly = reasoning.parts.length > 0 && reasoning.parts.every((part) => part.kind === 'summary')
  return (
    <details aria-label="Response reasoning" className="mb-3 rounded-xl border border-border/70 text-sm text-muted-foreground">
      <summary className="cursor-pointer rounded-xl px-3 py-2 select-none hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
        {summaryOnly ? 'Reasoning summary' : 'Reasoning'}
        {reasoning.tokens !== null && <> <span className="ml-2 text-xs tabular-nums">{reasoning.tokens.toLocaleString()} tokens</span></>}
      </summary>
      <div className="space-y-3 border-t border-border/70 px-3 py-3">
        {reasoning.parts.map((part) => (
          <div key={part.id}>
            <p className="mb-1 mt-0 text-xs font-medium">{part.kind === 'summary' ? 'Summary' : 'Provider reasoning text'}</p>
            <MarkdownContent content={part.text} />
          </div>
        ))}
        {!reasoning.parts.length && <p className="m-0 text-xs">The provider did not return visible reasoning text.</p>}
        {reasoning.encrypted && <p className="m-0 text-xs">The provider also returned protected reasoning that cannot be displayed.</p>}
      </div>
    </details>
  )
}
