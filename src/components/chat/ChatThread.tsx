import { useEffect, useRef, useState, type RefObject, type UIEventHandler } from 'react'
import { ArrowDown } from 'lucide-react'
import type { Message, Reasoning } from '../../types'
import { ReasoningContent } from './ReasoningContent'
import { ChatMessage } from './ChatMessage'
import { MarkdownContent } from './MarkdownContent'
import { IconButton } from '../ui/IconButton'

export function ChatThread({ messages, onSelectSibling, path, streamingText, streamingReasoning, copiedMessageId, editingMessageId, actionsDisabled, regenerateDisabled, messagesEndRef, onScroll, onJumpToLatest, onIncludedChange, onReasoningIncludedChange, onCopy, onEdit, onCancelEdit, onSaveEdit, onRegenerate, onDelete }: {
  messages: Message[]
  onSelectSibling: (message: Message) => void
  path: Message[]
  streamingText: string | null
  streamingReasoning: Reasoning | null
  copiedMessageId: string | null
  editingMessageId: string | null
  actionsDisabled: boolean
  regenerateDisabled: boolean
  messagesEndRef: RefObject<HTMLDivElement>
  onScroll: UIEventHandler<HTMLElement>
  onJumpToLatest: () => void
  onIncludedChange: (message: Message, included: boolean) => void
  onReasoningIncludedChange: (message: Message, partId: string, included: boolean) => void
  onEdit: (message: Message) => void
  onCancelEdit: () => void
  onSaveEdit: (content: string) => Promise<void>
  onCopy: (message: Message) => void
  onRegenerate: (message: Message) => void
  onDelete: (message: Message) => void
}) {
  const viewportRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const lastAssistantId = [...path].reverse().find((message) => message.role === 'assistant')?.id

  useEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return
    const observer = new ResizeObserver(() => setAtBottom(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48))
    observer.observe(viewport)
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <section ref={viewportRef} aria-label="Conversation messages" onScroll={(event) => {
        const viewport = event.currentTarget
        setAtBottom(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48)
        onScroll(event)
      }} className="scroll-stable min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4 pt-7 sm:px-6">
        <div ref={contentRef} className="mx-auto flex min-h-full w-full max-w-[52rem] flex-col">
          {path.length === 0 && (
            <div className="my-auto flex flex-col items-center px-4 py-12 text-center">
              <div className="mb-5 grid size-11 place-items-center rounded-2xl border border-border/70 text-lg font-semibold">C</div>
              <h2 className="m-0 text-2xl font-medium tracking-tight">Start a conversation</h2>
              <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">Add context, or start with a message.</p>
            </div>
          )}

          <div className="mb-8 flex flex-col gap-8 empty:hidden">
            {path.map((message) => (
              <ChatMessage
                key={message.id}
                message={message}
                siblings={messages.filter((item) => item.parent_id === message.parent_id)}
                onSelectSibling={onSelectSibling}
                copied={copiedMessageId === message.id}
                editing={editingMessageId === message.id}
                lastAssistant={message.id === lastAssistantId && streamingText === null}
                actionsDisabled={actionsDisabled || editingMessageId !== null}
                regenerateDisabled={regenerateDisabled}
                onIncludedChange={(included) => onIncludedChange(message, included)}
                onReasoningIncludedChange={(partId, included) => onReasoningIncludedChange(message, partId, included)}
                onCopy={() => onCopy(message)}
                onEdit={() => onEdit(message)}
                onCancelEdit={onCancelEdit}
                onSaveEdit={onSaveEdit}
                onRegenerate={() => onRegenerate(message)}
                onDelete={() => onDelete(message)}
              />
            ))}
            {streamingText !== null && (
              <article aria-label="Assistant response" aria-busy="true" className="flex w-full flex-col px-2 text-foreground">
                <ReasoningContent reasoning={streamingReasoning} />
                <MarkdownContent content={streamingText || '…'} />
                <span role="status" className="flex h-8 items-center text-xs text-muted-foreground">Streaming</span>
              </article>
            )}
          </div>
          <div ref={messagesEndRef} />
        </div>
      </section>
      {!atBottom && <IconButton variant="outline" className="absolute bottom-3 left-1/2 size-9 -translate-x-1/2 bg-background shadow-md" aria-label="Scroll to latest message" title="Scroll to latest message" onClick={onJumpToLatest}><ArrowDown size={17} /></IconButton>}
    </div>
  )
}
