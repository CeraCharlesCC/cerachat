import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { IconButton } from './IconButton'

export function Modal({ title, onClose, children, footer, wide = false }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-[2px]" role="presentation" onMouseDown={onClose}>
      <section className={`flex max-h-[90dvh] min-w-0 max-w-full flex-col overflow-hidden rounded-2xl border border-border/70 bg-popover text-popover-foreground shadow-[var(--shadow)] ${wide ? 'w-[min(900px,96vw)]' : 'w-[min(560px,96vw)]'}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header className="flex min-h-13 shrink-0 items-center justify-between border-b border-border/60 px-5 py-2.5">
          <h2 className="m-0 min-w-0 truncate text-sm font-semibold tracking-tight">{title}</h2>
          <IconButton onClick={onClose} aria-label="Close"><X size={16} /></IconButton>
        </header>
        <div className="scroll-stable min-h-0 overflow-auto p-5">{children}</div>
        {footer && <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border/70 bg-popover px-5 py-4">{footer}</footer>}
      </section>
    </div>
  )
}
