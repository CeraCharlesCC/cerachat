import { Check, Copy, MoreHorizontal, RefreshCw, Trash2 } from 'lucide-react'
import type { Message } from '../../types'
import { shortId } from '../../lib/utils'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'

export function MessageActions({ message, copied, disabled, onIncludedChange, onCopy, onRegenerate, onDelete }: {
  message: Message
  copied: boolean
  disabled: boolean
  onIncludedChange: (included: boolean) => void
  onCopy: () => void
  onRegenerate: () => void
  onDelete: () => void
}) {
  return (
    <div className={`flex min-h-8 items-center gap-0.5 text-muted-foreground opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <label className="mr-1 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2 text-[11px] hover:bg-accent hover:text-foreground" title="Include this message in selected/future history modes">
        <input className="sr-only" type="checkbox" checked={message.include_next} onChange={(event) => onIncludedChange(event.target.checked)} />
        <span className={`grid size-3.5 place-items-center rounded-full border ${message.include_next ? 'border-primary bg-primary text-primary-foreground' : 'border-border'}`}>{message.include_next && <Check size={10} strokeWidth={3} />}</span>
        <span>{message.include_next ? 'Included' : 'Include next'}</span>
      </label>
      <IconButton className="size-7" aria-label={copied ? 'Copied' : 'Copy message'} title={copied ? 'Copied' : 'Copy message'} onClick={onCopy}>
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </IconButton>
      {message.role === 'assistant' && (
        <IconButton className="size-7" aria-label="Regenerate response" title="Regenerate response" disabled={disabled} onClick={onRegenerate}>
          <RefreshCw size={15} />
        </IconButton>
      )}
      <details className="message-overflow relative">
        <summary className="grid size-7 cursor-pointer list-none place-items-center rounded-full hover:bg-accent hover:text-foreground" aria-label="More message actions" title="More message actions"><MoreHorizontal size={16} /></summary>
        <div className={`absolute z-20 mt-1 min-w-44 rounded-xl border border-border/70 bg-popover p-1.5 text-popover-foreground shadow-lg ${message.role === 'user' ? 'right-0' : 'left-0'}`}>
          <span className="block px-2 py-1 text-[10px] text-muted-foreground">Message {shortId(message.id)}</span>
          <Button variant="destructive" size="sm" className="w-full justify-start" onClick={onDelete}><Trash2 size={14} /> Delete branch</Button>
        </div>
      </details>
    </div>
  )
}
