import type { Message } from '../../types'
import { MarkdownContent } from './MarkdownContent'
import { MessageActions } from './MessageActions'

export function ChatMessage({ message, copied, actionsDisabled, onIncludedChange, onCopy, onRegenerate, onDelete }: {
  message: Message
  copied: boolean
  actionsDisabled: boolean
  onIncludedChange: (included: boolean) => void
  onCopy: () => void
  onRegenerate: () => void
  onDelete: () => void
}) {
  const isUser = message.role === 'user'

  return (
    <article className={`group/message flex w-full flex-col ${isUser ? 'items-end' : 'items-stretch'}`}>
      <div className={isUser
        ? 'max-w-[85%] min-w-0 rounded-2xl bg-muted px-4 py-2.5 text-foreground md:max-w-[75%]'
        : 'w-full px-2 text-foreground'}>
        <MarkdownContent content={message.content} />
      </div>
      <div className={isUser ? 'mr-1' : 'ml-1'}>
        <MessageActions
          message={message}
          copied={copied}
          disabled={actionsDisabled}
          onIncludedChange={onIncludedChange}
          onCopy={onCopy}
          onRegenerate={onRegenerate}
          onDelete={onDelete}
        />
      </div>
    </article>
  )
}
