import type { RefObject, UIEventHandler } from 'react'
import type { Message } from '../../types'
import { ChatMessage } from './ChatMessage'
import { MarkdownContent } from './MarkdownContent'

export function ChatThread({ path, streamingText, copiedMessageId, actionsDisabled, messagesEndRef, onScroll, onIncludedChange, onCopy, onRegenerate, onDelete }: {
  path: Message[]
  streamingText: string | null
  copiedMessageId: string | null
  actionsDisabled: boolean
  messagesEndRef: RefObject<HTMLDivElement>
  onScroll: UIEventHandler<HTMLElement>
  onIncludedChange: (message: Message, included: boolean) => void
  onCopy: (message: Message) => void
  onRegenerate: (message: Message) => void
  onDelete: (message: Message) => void
}) {
  return (
    <section onScroll={onScroll} className="scroll-stable min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pt-4">
      <div className="mx-auto flex min-h-full w-full max-w-[44rem] flex-col">
        {path.length === 0 && (
          <div className="my-auto flex flex-col items-center px-4 py-12 text-center">
            <div className="mb-5 grid size-11 place-items-center rounded-2xl border border-border/70 text-lg font-semibold">C</div>
            <h2 className="m-0 text-2xl font-medium tracking-tight">Start a conversation</h2>
            <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">Add context, or start with a message.</p>
          </div>
        )}

        <div className="mb-6 flex flex-col gap-6 empty:hidden">
          {path.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              copied={copiedMessageId === message.id}
              actionsDisabled={actionsDisabled}
              onIncludedChange={(included) => onIncludedChange(message, included)}
              onCopy={() => onCopy(message)}
              onRegenerate={() => onRegenerate(message)}
              onDelete={() => onDelete(message)}
            />
          ))}
          {streamingText !== null && (
            <article className="flex w-full flex-col px-2 text-foreground" aria-live="polite">
              <MarkdownContent content={streamingText || '…'} />
              <span className="flex h-8 items-center text-xs text-muted-foreground">Streaming</span>
            </article>
          )}
        </div>
        <div ref={messagesEndRef} />
      </div>
    </section>
  )
}
