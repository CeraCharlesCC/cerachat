import { ArrowUp, LoaderCircle } from 'lucide-react'
import { useEffect, type KeyboardEvent, type RefObject } from 'react'
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
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 192)}px`
  }, [input, textareaRef])

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      onSend()
    }
  }

  return (
    <section className="shrink-0 bg-gradient-to-t from-background via-background to-transparent px-4 pb-4 pt-2 md:pb-6">
      <div className="mx-auto w-full max-w-[44rem]">
        <div className="mb-2 flex min-h-7 flex-wrap items-center gap-2 px-2 text-[11px] text-muted-foreground">
          <label className="inline-flex items-center gap-1.5">
            <span>History</span>
            <select className="h-7 rounded-md border border-border/70 bg-background px-2 text-[11px] text-foreground outline-none hover:bg-accent" value={historyMode} onChange={(event) => onHistoryModeChange(event.target.value as HistoryMode)}>
              <option value="full">Full branch</option>
              <option value="last10">Last 10 messages</option>
              <option value="since_here">Since here</option>
              <option value="selected">Selected messages</option>
              <option value="no_history">No history</option>
            </select>
          </label>
          {historyMode === 'since_here' && (
            <select className="h-7 min-w-0 max-w-64 rounded-md border border-border/70 bg-background px-2 text-[11px] text-foreground outline-none hover:bg-accent" aria-label="Since message" value={sinceMessageId ?? ''} onChange={(event) => onSinceMessageChange(event.target.value || null)}>
              <option value="">Choose message…</option>
              {path.map((message) => <option value={message.id} key={message.id}>{message.role}: {message.content.slice(0, 45)}</option>)}
            </select>
          )}
          <span className="ml-auto whitespace-nowrap">{formatTokens(historyTokens)} history · {formatTokens(workspaceTokens)} workspace · ~{formatTokens(estimateTokens(input))} input</span>
        </div>

        <div className="rounded-3xl border border-border/70 bg-card p-2 shadow-sm transition-colors focus-within:border-border">
          <textarea
            ref={textareaRef}
            className="block max-h-48 min-h-10 w-full resize-none overflow-y-auto bg-transparent px-2.5 py-1 text-[15px] leading-6 text-card-foreground outline-none placeholder:text-muted-foreground/60"
            rows={1}
            placeholder="Message the model…"
            aria-label="Message input"
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="mt-1 flex items-end justify-between gap-2">
            <div className="min-w-0 px-2 pb-0.5 text-[10px] leading-4 text-muted-foreground">
              <span className="block">{input.length.toLocaleString()} chars / ~{formatTokens(Math.ceil(input.length / 4))}</span>
              <span className="hidden sm:block">Enter to send · Shift+Enter for a new line</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Button variant="ghost" size="sm" disabled={!canCompile} onClick={onPreview}>Preview request</Button>
              <IconButton variant="primary" className="size-8" disabled={busy || !canCompile} onClick={onSend} aria-label="Send message" title="Send message">
                {streaming || busy ? <LoaderCircle className="animate-spin" size={16} /> : <ArrowUp size={16} />}
              </IconButton>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
