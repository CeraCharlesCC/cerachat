import { ChevronLeft, ChevronRight } from 'lucide-react'
import { IconButton } from '../ui/IconButton'
import type { Message } from '../../types'
import { MarkdownContent } from './MarkdownContent'
import { MessageActions } from './MessageActions'

export function ChatMessage({ message, copied, actionsDisabled, regenerateDisabled, siblings, onSelectSibling, onIncludedChange, onCopy, onEdit, onRegenerate, onDelete }: {
  siblings: Message[]
  onSelectSibling: (message: Message) => void
  message: Message
  copied: boolean
  actionsDisabled: boolean
  regenerateDisabled: boolean
  onIncludedChange: (included: boolean) => void
  onEdit: () => void
  onCopy: () => void
  onRegenerate: () => void
  onDelete: () => void
}) {
  const siblingIndex = siblings.findIndex((sibling) => sibling.id === message.id)
  const isUser = message.role === 'user'

  return (
    <article className={`group/message flex w-full flex-col ${isUser ? 'items-end' : 'items-stretch'}`}>
      <div className={isUser
        ? 'max-w-[85%] min-w-0 rounded-2xl bg-muted px-4 py-2.5 text-foreground md:max-w-[75%]'
        : 'w-full px-2 text-foreground'}>
        <MarkdownContent content={message.content} />
      </div>
      <div className={`flex flex-wrap items-center gap-2 ${isUser ? 'mr-1 justify-end' : 'ml-1'}`}>
        {siblings.length > 1 && <nav aria-label="Message branches" className="flex items-center text-xs text-muted-foreground">
          <IconButton className="size-7" aria-label="Previous branch" disabled={actionsDisabled || siblingIndex <= 0} onClick={() => onSelectSibling(siblings[siblingIndex - 1])}><ChevronLeft size={14} /></IconButton>
          <span className="min-w-8 text-center tabular-nums">{siblingIndex + 1}/{siblings.length}</span>
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
          onRegenerate={onRegenerate}
          onDelete={onDelete}
        />
      </div>
    </article>
  )
}
