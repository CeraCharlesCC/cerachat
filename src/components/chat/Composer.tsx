import { ArrowUp, LoaderCircle } from 'lucide-react'
import { type KeyboardEvent, type RefObject } from 'react'
import type { HistoryMode, Message } from '../../types'
import { estimateTokens, formatTokens } from '../../lib/utils'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'

export function Composer({ textareaRef, input, historyMode, sinceMessageId, path, historyTokens, workspaceTokens, canCompile, busy, streaming, onInputChange, onHistoryModeChange, onSinceMessageChange, onPreview, onSend }: {
  textareaRef: RefObject<HTMLTextAreaElement>
  input: string
  historyMode: HistoryMode
  sinceMessageId: string | null
  path: Message[]
  historyTokens: number
  workspaceTokens: number
  canCompile: boolean
  busy: boolean
  streaming: boolean
  onInputChange: (value: string) => void
  onHistoryModeChange: (mode: HistoryMode) => void
  onSinceMessageChange: (messageId: string | null) => void
  onPreview: () => void
  onSend: () => void
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      onSend()
    }
  }

  return (
    <section className="shrink-0 bg-gradient-to-t from-background via-background to-transparent px-4 pb-4 pt-2 md:pb-6">
      <div className="mx-auto w-full max-w-[44rem]">
        <div className="mb-3 grid grid-cols-2 items-center gap-2 px-1">
          <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">History</span>
            <select className="h-8 w-full min-w-0 rounded-lg border border-border/70 bg-card px-2 text-xs text-foreground" value={historyMode} onChange={(event) => onHistoryModeChange(event.target.value as HistoryMode)}>
              <option value="full">Full branch</option>
              <option value="last10">Last 10 messages</option>
              <option value="since_here">Since here</option>
              <option value="selected">Selected messages</option>
              <option value="no_history">No history</option>
            </select>
          </label>
          <select className={`h-8 w-full min-w-0 rounded-lg border border-border/70 bg-card px-2 text-xs text-foreground ${historyMode === 'since_here' ? '' : 'invisible'}`} disabled={historyMode !== 'since_here'} aria-label="Since message" value={sinceMessageId ?? ''} onChange={(event) => onSinceMessageChange(event.target.value || null)}>
            <option value="">Choose message…</option>
            {path.map((message) => <option value={message.id} key={message.id}>{message.role}: {message.content.slice(0, 45)}</option>)}
          </select>
        </div>

        <div className="rounded-2xl border border-input bg-card p-2 shadow-sm transition-colors focus-within:border-ring">
          <textarea
            ref={textareaRef}
            className="scroll-stable block h-24 w-full resize-none overflow-y-auto bg-transparent px-3 py-2 text-[15px] leading-6 text-card-foreground outline-none placeholder:text-muted-foreground"
            rows={3}
            placeholder="Message the model…"
            aria-label="Message input"
            title="Enter to send · Shift+Enter for a new line"
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="mt-1 flex items-end justify-between gap-2">
            <span className="min-w-0 truncate px-3 pb-2 text-xs tabular-nums text-muted-foreground" title={`${input.length.toLocaleString()} characters`}>{input.length.toLocaleString()} chars</span>
            <div className="flex items-center gap-1.5">
              <Button variant="ghost" size="sm" disabled={!canCompile} onClick={onPreview}>Preview</Button>
              <IconButton variant="primary" className="size-8" disabled={busy || !canCompile} onClick={onSend} aria-label="Send message" title="Send message (Enter)">
                {streaming || busy ? <LoaderCircle className="animate-spin" size={16} /> : <ArrowUp size={16} />}
              </IconButton>
            </div>
          </div>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2 px-2 text-[11px] tabular-nums text-muted-foreground" aria-label="Estimated tokens">
          {([['History', historyTokens], ['Context', workspaceTokens], ['Input', estimateTokens(input)]] as const).map(([label, tokens]) => (
            <span key={label} className="flex min-w-0 items-center justify-between gap-1">
              <span>{label}</span><span className="truncate text-right" title={`${tokens.toLocaleString()} estimated tokens`}>~{formatTokens(tokens)}</span>
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}
