import { Check, Copy, MoreHorizontal, Pencil, Play, RefreshCw, Trash2 } from 'lucide-react'
import { type RefObject, useEffect, useRef, useState } from 'react'
import type { Message } from '../../types'
import { shortId } from '../../lib/utils'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'

export function MessageActions({ message, copied, disabled, regenerateDisabled, editButtonRef, onIncludedChange, onCopy, onEdit, onRegenerate, onDelete }: {
  message: Message
  copied: boolean
  disabled: boolean
  regenerateDisabled: boolean
  editButtonRef: RefObject<HTMLButtonElement>
  onIncludedChange: (included: boolean) => void
  onEdit: () => void
  onCopy: () => void
  onRegenerate: () => void
  onDelete: () => void
}) {
  const overflowRef = useRef<HTMLDetailsElement>(null)
  const [overflowOpen, setOverflowOpen] = useState(false)

  useEffect(() => {
    if (!overflowOpen) return
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !overflowRef.current?.contains(event.target) && overflowRef.current) overflowRef.current.open = false
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !overflowRef.current) return
      overflowRef.current.open = false
      overflowRef.current.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [overflowOpen])

  return (
    <div role="group" aria-label="Message actions" className={`message-actions flex min-h-8 items-center gap-0.5 text-muted-foreground ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <button
        type="button"
        className="mr-1 inline-flex h-7 w-28 cursor-pointer items-center gap-1.5 rounded-full px-2 text-[11px] hover:bg-accent hover:text-foreground"
        aria-pressed={message.include_next}
        aria-label="Include message in request history"
        title="Include this message in request history"
        disabled={disabled}
        onClick={() => onIncludedChange(!message.include_next)}
      >
        <span className={`grid size-3.5 place-items-center rounded-full border ${message.include_next ? 'border-primary bg-primary text-primary-foreground' : 'border-border'}`}>{message.include_next && <Check size={10} strokeWidth={3} />}</span>
        <span>{message.include_next ? 'Included' : 'Include next'}</span>
      </button>
      <IconButton className="size-7" aria-label={copied ? 'Copied' : 'Copy message'} title={copied ? 'Copied' : 'Copy message'} onClick={onCopy}>
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </IconButton>
      <button ref={editButtonRef} type="button" className="grid size-7 place-items-center rounded-full hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-45" aria-label="Edit message" title="Edit into a new branch" disabled={disabled} onClick={onEdit}><Pencil size={15} /></button>
      {message.role === 'user' && (
        <IconButton className="size-7" aria-label="Generate response" title="Generate response from this message" disabled={disabled || regenerateDisabled} onClick={onRegenerate}><Play size={15} /></IconButton>
      )}
      {message.role === 'assistant' && (
        <IconButton className="size-7" aria-label="Regenerate response" title="Regenerate response" disabled={disabled || regenerateDisabled} onClick={onRegenerate}>
          <RefreshCw size={15} />
        </IconButton>
      )}
      <details ref={overflowRef} onToggle={(event) => setOverflowOpen(event.currentTarget.open)} className="message-overflow relative">
        <summary className="grid size-7 cursor-pointer list-none place-items-center rounded-full hover:bg-accent hover:text-foreground" aria-label="More message actions" title="More message actions"><MoreHorizontal size={16} /></summary>
        <div className={`absolute z-20 mt-1 min-w-44 rounded-xl border border-border/70 bg-popover p-1.5 text-popover-foreground shadow-lg ${message.role === 'user' ? 'right-0' : 'left-0'}`}>
          <span className="block px-2 py-1 text-[10px] text-muted-foreground">Message {shortId(message.id)}</span>
          <Button variant="destructive" size="sm" className="w-full justify-start" disabled={disabled} onClick={onDelete}><Trash2 size={14} /> Delete branch</Button>
        </div>
      </details>
    </div>
  )
}
