import type { Message } from '../../types'

function depthFor(message: Message, byId: Map<string, Message>): number {
  let depth = 0
  let parentId = message.parent_id
  let guard = 0
  while (parentId && guard < byId.size) {
    depth += 1
    parentId = byId.get(parentId)?.parent_id ?? null
    guard += 1
  }
  return depth
}

export function BranchTree({ messages, activeLeafId, onSelect }: { messages: Message[]; activeLeafId: string | null; onSelect: (messageId: string) => void }) {
  const byId = new Map(messages.map((message) => [message.id, message]))

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      {messages.map((message) => (
        <button
          key={message.id}
          className={`flex h-8 w-full items-center rounded-md pr-2 text-left text-xs transition-colors hover:bg-muted focus-visible:bg-muted ${message.id === activeLeafId ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
          style={{ paddingLeft: `${10 + depthFor(message, byId) * 12}px` }}
          onClick={() => onSelect(message.id)}
        >
          <span className={`mr-2 size-1.5 shrink-0 rounded-full ${message.role === 'assistant' ? 'bg-foreground' : 'bg-muted-foreground/70'}`} />
          <span className="truncate">{message.content.replace(/\s+/g, ' ').slice(0, 40) || '(empty)'}</span>
        </button>
      ))}
    </div>
  )
}
