import { Plus, Settings, Trash2 } from 'lucide-react'
import type { Conversation, Message } from '../../types'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { BranchTree } from './BranchTree'

type ThreadSidebarProps = {
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
      className={`flex min-h-0 min-w-0 flex-col border-r border-border/60 bg-card max-[1100px]:fixed max-[1100px]:inset-y-0 max-[1100px]:left-0 max-[1100px]:z-40 max-[1100px]:w-[min(360px,88vw)] max-[1100px]:shadow-[var(--shadow)] max-[1100px]:transition-transform ${open ? 'max-[1100px]:translate-x-0' : 'max-[1100px]:-translate-x-[105%]'}`}
    >
      <header className="flex min-h-16 items-center justify-between border-b border-border/60 px-3.5">
        <div className="min-w-0">
          <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Local</span>
          <h1 className="m-0 truncate text-base font-semibold tracking-tight">CeraChat</h1>
        </div>
        <IconButton aria-label="Provider settings" title="Provider settings" onClick={onOpenSettings}>
          <Settings size={16} />
        </IconButton>
      </header>

      <div className="px-2 pt-2">
        <Button variant="ghost" size="sm" className="w-full justify-start px-2.5 font-normal" onClick={onNewChat}>
          <Plus size={16} /> New chat
        </Button>
      </div>

      <div className="px-3 pb-1 pt-3 text-[11px] font-medium text-muted-foreground">Conversations</div>
      <div className="max-h-[34vh] overflow-y-auto px-2 pb-2">
        {conversations.map((conversation) => (
          <div
            key={conversation.id}
            className={`group/thread flex h-8 items-center rounded-md transition-colors hover:bg-muted ${conversation.id === conversationId ? 'bg-muted' : ''}`}
          >
            <button
              className="min-w-0 flex-1 truncate px-2.5 text-left text-sm"
              onClick={() => onSelectConversation(conversation.id)}
              title={conversation.title}
            >
              {conversation.title}
            </button>
            <IconButton
              className="mr-1 size-7 opacity-0 group-hover/thread:opacity-100 group-focus-within/thread:opacity-100"
              variant="destructive"
              aria-label={`Delete ${conversation.title}`}
              title="Delete conversation"
              onClick={() => onDeleteConversation(conversation.id)}
            >
              <Trash2 size={14} />
            </IconButton>
          </div>
        ))}
      </div>

      <div className="mt-1 border-t border-border/60 px-3 pb-1 pt-3 text-[11px] font-medium text-muted-foreground">Branches</div>
      <BranchTree messages={messages} activeLeafId={activeLeafId} onSelect={onSelectLeaf} />

      <footer className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-2 text-[10px] text-muted-foreground">
        <span>{desktop ? 'Desktop' : 'Browser demo'}</span>
        <code className="min-w-0 truncate" title={dataDir}>{dataDirLabel}</code>
      </footer>
    </aside>
  )
}
