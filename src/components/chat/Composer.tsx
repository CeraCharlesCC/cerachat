import { ArrowUp, LoaderCircle, Square } from 'lucide-react'
import { type KeyboardEvent, type RefObject } from 'react'
import type { HistoryMode, Message } from '../../types'
import { estimateTokens, formatTokens } from '../../lib/utils'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'

export function Composer({ height, textareaRef, input, historyMode, sinceMessageId, path, historyTokens, workspaceTokens, canCompile, busy, streaming, stopping, editing, onInputChange, onHistoryModeChange, onSinceMessageChange, onPreview, onSend, onStop }: {
  height: number
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
  stopping: boolean
  editing: boolean
  onInputChange: (value: string) => void
  onHistoryModeChange: (mode: HistoryMode) => void
  onSinceMessageChange: (messageId: string | null) => void
  onPreview: () => void
  onSend: () => void
  onStop: () => void
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault()
      onSend()
    }
  }

  return (
    <section id="message-composer" aria-label="Message composer" style={{ height }} className="shrink-0 px-4 pb-4 pt-2 sm:px-6">
      <div className="mx-auto flex h-full w-full max-w-[52rem] flex-col">
        <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2 px-1">
          <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">History</span>
            <select className="h-8 min-w-0 rounded-lg border border-border/70 bg-card px-2 text-xs text-foreground" value={historyMode} onChange={(event) => onHistoryModeChange(event.target.value as HistoryMode)}>
              <option value="full">Full branch</option>
              <option value="last10">Last 10 messages</option>
              <option value="since_here">Since here</option>
              <option value="selected">Selected messages</option>
              <option value="no_history">No history</option>
            </select>
          </label>
          <select className={`h-8 min-w-0 max-w-full flex-1 rounded-lg border border-border/70 bg-card px-2 text-xs text-foreground ${historyMode === 'since_here' ? '' : 'hidden'}`} disabled={historyMode !== 'since_here'} aria-label="Since message" value={sinceMessageId ?? ''} onChange={(event) => onSinceMessageChange(event.target.value || null)}>
            <option value="">Choose message…</option>
            {path.map((message) => <option value={message.id} key={message.id}>{message.role}: {message.content.slice(0, 45)}</option>)}
          </select>
        </div>

        <form aria-label="Send message" onSubmit={(event) => { event.preventDefault(); if (canCompile) onSend() }} className="flex min-h-0 flex-1 flex-col rounded-2xl border border-input bg-card p-2 shadow-sm transition-colors focus-within:border-ring">
          <textarea
            ref={textareaRef}
            className="scroll-stable block min-h-0 w-full flex-1 resize-none overflow-y-auto bg-transparent px-3 py-2 text-[15px] leading-6 text-card-foreground outline-none placeholder:text-muted-foreground"
            rows={3}
            placeholder="Message the model…"
            aria-label="Message input"
            title="Enter to send · Shift+Enter for a new line"
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="mt-1 flex shrink-0 items-end justify-between gap-2">
            <span className="min-w-0 truncate px-3 pb-2 text-xs tabular-nums text-muted-foreground" title={editing ? 'Finish editing the message above. Your unsent draft is kept here.' : `${input.length.toLocaleString()} characters`}>{editing ? 'Editing message · draft kept' : `${input.length.toLocaleString()} chars`}</span>
            <div className="flex items-center gap-1.5">
              <Button variant="ghost" size="sm" disabled={!canCompile} onClick={onPreview}>Preview</Button>
              <IconButton
                type={streaming ? 'button' : 'submit'}
                variant="primary"
                className="size-8"
                disabled={streaming ? stopping : busy || !canCompile}
                aria-label={streaming ? 'Stop generating' : 'Send message'}
                title={streaming ? (stopping ? 'Stopping…' : 'Stop generating') : 'Send message (Enter)'}
                onClick={streaming ? (event) => {
                  // Cancellation can switch this button back to submit during the click.
                  event.preventDefault()
                  onStop()
                } : undefined}
              >
                {stopping || (busy && !streaming) ? <LoaderCircle className="animate-spin" size={16} /> : streaming ? <Square size={14} fill="currentColor" /> : <ArrowUp size={16} />}
              </IconButton>
            </div>
          </div>
        </form>
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
