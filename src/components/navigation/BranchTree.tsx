import type { Message } from '../../types'

export function BranchTree({ messages, activeLeafId, onSelect, disabled }: { disabled: boolean; messages: Message[]; activeLeafId: string | null; onSelect: (messageId: string) => void }) {
  const children = new Map<string | null, Message[]>()
  for (const message of messages) children.set(message.parent_id, [...(children.get(message.parent_id) ?? []), message])
  const rows: { message: Message; depth: number }[] = []
  const queue = (children.get(null) ?? []).map((message) => ({ message, depth: 0 })).reverse()
  const visited = new Set<string>()
  while (queue.length) {
    const row = queue.pop()!
    if (visited.has(row.message.id)) continue
    visited.add(row.message.id)
    rows.push(row)
    for (const child of [...(children.get(row.message.id) ?? [])].reverse()) queue.push({ message: child, depth: row.depth + 1 })
  }

  return (
    <div className="min-h-0 flex-1 scroll-stable overflow-y-auto px-2 pb-3">
      {rows.map(({ message, depth }) => (
        <button
          key={message.id}
          disabled={disabled}
          className={`flex h-8 w-full items-center rounded-md pr-2 text-left text-xs transition-colors hover:bg-muted focus-visible:bg-muted ${message.id === activeLeafId ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
          style={{ paddingLeft: `${10 + Math.min(depth, 8) * 12}px` }}
          aria-current={message.id === activeLeafId ? 'true' : undefined}
          title={message.content}
          onClick={() => onSelect(message.id)}
        >
          <span className={`mr-2 size-1.5 shrink-0 rounded-full ${message.role === 'assistant' ? 'bg-foreground' : 'bg-muted-foreground/70'}`} />
          <span className="truncate">{message.content.replace(/\s+/g, ' ').slice(0, 40) || '(empty)'}</span>
        </button>
      ))}
    </div>
  )
}
