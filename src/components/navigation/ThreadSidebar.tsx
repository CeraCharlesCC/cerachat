import { Plus, Settings, Trash2 } from 'lucide-react'
import type { Conversation, Message } from '../../types'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { BranchTree } from './BranchTree'

type ThreadSidebarProps = {
  disabled: boolean
  open: boolean
  conversations: Conversation[]
  conversationId: string | null
  messages: Message[]
  activeLeafId: string | null
  dataDir?: string
  desktop: boolean
  onNewChat: () => void
  onSelectConversation: (conversationId: string) => void
  onDeleteConversation: (conversationId: string) => void
  onSelectLeaf: (messageId: string) => void
  onOpenSettings: () => void
}

export function ThreadSidebar({
  open,
  disabled,
  conversations,
  conversationId,
  messages,
  activeLeafId,
  dataDir,
  desktop,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
  onSelectLeaf,
  onOpenSettings,
}: ThreadSidebarProps) {
  const dataDirLabel = dataDir ? dataDir.split(/[\\/]/).slice(-1)[0] : 'local'

  return (
    <aside
      id="threads-panel"
      className={`panel flex min-h-0 min-w-0 flex-col max-[1100px]:fixed max-[1100px]:inset-y-0 max-[1100px]:left-0 max-[1100px]:z-40 max-[1100px]:w-[min(360px,88vw)] max-[1100px]:shadow-[var(--shadow)] max-[1100px]:transition-transform ${open ? 'max-[1100px]:translate-x-0' : 'min-[1101px]:hidden max-[1100px]:invisible max-[1100px]:-translate-x-[105%]'}`}
    >
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-border/60 px-3.5">
        <div className="min-w-0">
          <h1 className="m-0 truncate text-base font-semibold tracking-tight">CeraChat</h1>
        </div>
        <IconButton aria-label="Provider settings" title="Provider settings" onClick={onOpenSettings}>
          <Settings size={16} />
        </IconButton>
      </header>

      <div className="px-3 pt-4">
        <Button variant="outline" className="w-full justify-start" disabled={disabled} onClick={onNewChat}>
          <Plus size={16} /> New chat
        </Button>
      </div>

      <div className="px-4 pb-2 pt-5 text-xs font-medium text-muted-foreground">Conversations</div>
      <div className="max-h-[34vh] shrink-0 scroll-stable overflow-y-auto px-3 pb-4">
        {conversations.map((conversation) => (
          <div
            key={conversation.id}
            className={`group/thread flex h-10 items-center rounded-lg transition-colors hover:bg-muted ${conversation.id === conversationId ? 'bg-muted' : ''}`}
          >
            <button
              className="min-w-0 flex-1 truncate px-2.5 text-left text-sm"
              disabled={disabled}
              onClick={() => onSelectConversation(conversation.id)}
              aria-current={conversation.id === conversationId ? 'page' : undefined}
              title={conversation.title}
            >
              {conversation.title}
            </button>
            <IconButton
              className="mr-1 size-7 opacity-0 group-hover/thread:opacity-100 group-focus-within/thread:opacity-100"
              variant="destructive"
              aria-label={`Delete ${conversation.title}`}
              title="Delete conversation"
              disabled={disabled}
              onClick={() => onDeleteConversation(conversation.id)}
            >
              <Trash2 size={14} />
            </IconButton>
          </div>
        ))}
      </div>

      <div className="border-t border-border/60 px-4 pb-2 pt-4 text-xs font-medium text-muted-foreground">Branches</div>
      <BranchTree disabled={disabled} messages={messages} activeLeafId={activeLeafId} onSelect={onSelectLeaf} />

      <footer className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
        <span>{desktop ? 'Desktop' : 'Browser demo'}</span>
        <code className="min-w-0 truncate" title={dataDir}>{dataDirLabel}</code>
      </footer>
    </aside>
  )
}
