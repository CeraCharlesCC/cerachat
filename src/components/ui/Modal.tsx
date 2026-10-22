import { X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { IconButton } from './IconButton'

export function Modal({ title, onClose, children, footer, wide = false }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const dialogRef = useRef<HTMLElement>(null)
  const previousFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  useEffect(() => {
    const previousFocus = previousFocusRef.current
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('button, input, textarea, select, summary, a[href], [tabindex]'))
      .filter((element) => !element.hasAttribute('disabled') && element.tabIndex >= 0 && element.getClientRects().length > 0)
    if (!dialog.contains(document.activeElement)) (focusable()[0] ?? dialog).focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current() }
      if (event.key !== 'Tab') return
      const elements = focusable()
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (!first) { event.preventDefault(); dialog.focus(); return }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    dialog.addEventListener('keydown', handleKey)
    return () => {
      dialog.removeEventListener('keydown', handleKey)
      queueMicrotask(() => { if (!dialog.isConnected && previousFocus?.isConnected) previousFocus.focus() })
    }
  }, [])
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-[2px]" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} tabIndex={-1} className={`flex max-h-[90dvh] min-w-0 max-w-full flex-col overflow-hidden rounded-2xl border border-border/70 bg-popover text-popover-foreground shadow-[var(--shadow)] ${wide ? 'w-[min(900px,96vw)]' : 'w-[min(560px,96vw)]'}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
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
