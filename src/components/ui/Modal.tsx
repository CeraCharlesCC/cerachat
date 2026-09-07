import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { IconButton } from './IconButton'

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4 backdrop-blur-[2px]" role="presentation" onMouseDown={onClose}>
      <section className={`flex max-h-[90vh] flex-col overflow-hidden rounded-2xl border border-border/70 bg-popover text-popover-foreground shadow-[var(--shadow)] ${wide ? 'w-[min(900px,96vw)]' : 'w-[min(560px,96vw)]'}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header className="flex min-h-13 items-center justify-between border-b border-border/60 px-5 py-2.5">
          <h2 className="m-0 text-sm font-semibold tracking-tight">{title}</h2>
          <IconButton onClick={onClose} aria-label="Close"><X size={16} /></IconButton>
        </header>
        <div className="overflow-auto p-5">{children}</div>
      </section>
    </div>
  )
}
