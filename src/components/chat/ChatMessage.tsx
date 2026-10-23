import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useRef } from 'react'
import { IconButton } from '../ui/IconButton'
import type { Message } from '../../types'
import { MarkdownContent } from './MarkdownContent'
import { MessageActions } from './MessageActions'
import { ReasoningContent } from './ReasoningContent'
import { MessageEditor } from './MessageEditor'

export function ChatMessage({ message, copied, editing, lastAssistant, actionsDisabled, regenerateDisabled, siblings, onSelectSibling, onIncludedChange, onCopy, onEdit, onCancelEdit, onSaveEdit, onRegenerate, onDelete }: {
  siblings: Message[]
  onSelectSibling: (message: Message) => void
  message: Message
  copied: boolean
  editing: boolean
  lastAssistant: boolean
  actionsDisabled: boolean
  regenerateDisabled: boolean
  onIncludedChange: (included: boolean) => void
  onEdit: () => void
  onCancelEdit: () => void
  onSaveEdit: (content: string) => Promise<void>
  onCopy: () => void
  onRegenerate: () => void
  onDelete: () => void
}) {
  const siblingIndex = siblings.findIndex((sibling) => sibling.id === message.id)
  const isUser = message.role === 'user'
  const editButtonRef = useRef<HTMLButtonElement>(null)

  return (
    <article aria-label={isUser ? 'User message' : 'Assistant message'} data-last-assistant={lastAssistant} className={`group/message flex w-full min-w-0 flex-col gap-1 ${isUser ? 'items-end' : 'items-stretch'}`}>
      {editing ? <MessageEditor message={message} onSave={onSaveEdit} onCancel={() => {
        onCancelEdit()
        requestAnimationFrame(() => editButtonRef.current?.focus({ preventScroll: true }))
      }} /> : <>
        <div className={isUser
          ? 'max-w-[85%] min-w-0 rounded-2xl bg-muted px-4 py-2.5 text-foreground md:max-w-[75%]'
          : 'w-full px-2 text-foreground'}>
          {!isUser && <ReasoningContent reasoning={message.reasoning} />}
          {isUser ? <div className="whitespace-pre-wrap break-words text-[15px] leading-[1.8] [overflow-wrap:anywhere]">{message.content}</div> : <MarkdownContent content={message.content} />}
        </div>
        <div className={`message-action-row flex flex-wrap items-center gap-2 transition-opacity ${isUser ? 'mr-1 justify-end' : 'ml-1'}`}>
          {siblings.length > 1 && <nav aria-label="Message branches" className="flex items-center text-xs text-muted-foreground">
            <IconButton className="size-7" aria-label="Previous branch" disabled={actionsDisabled || siblingIndex <= 0} onClick={() => onSelectSibling(siblings[siblingIndex - 1])}><ChevronLeft size={14} /></IconButton>
            <span aria-live="polite" aria-atomic="true" className="min-w-8 text-center tabular-nums">{siblingIndex + 1}/{siblings.length}</span>
            <IconButton className="size-7" aria-label="Next branch" disabled={actionsDisabled || siblingIndex >= siblings.length - 1} onClick={() => onSelectSibling(siblings[siblingIndex + 1])}><ChevronRight size={14} /></IconButton>
          </nav>}
          <MessageActions
            message={message}
            copied={copied}
            disabled={actionsDisabled}
            regenerateDisabled={regenerateDisabled}
            onIncludedChange={onIncludedChange}
            onCopy={onCopy}
            onEdit={onEdit}
            editButtonRef={editButtonRef}
            onRegenerate={onRegenerate}
            onDelete={onDelete}
          />
        </div>
      </>}
    </article>
  )
}
