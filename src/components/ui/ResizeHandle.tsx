import { useRef, useState, type KeyboardEvent } from 'react'

type ResizeHandleProps = {
  label: string
  controls: string
  orientation?: 'vertical' | 'horizontal'
  value: number
  min: number
  max: number
  direction?: 1 | -1
  onChange: (value: number) => void
  onReset: () => void
}

export function ResizeHandle({ label, controls, orientation = 'vertical', value, min, max, direction = 1, onChange, onReset }: ResizeHandleProps) {
  const drag = useRef<{ pointerId: number; start: number; value: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const clamp = (next: number) => Math.round(Math.min(max, Math.max(min, next)))

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const decrease = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
    const increase = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'
    if (event.key === decrease || event.key === increase) {
      event.preventDefault()
      onChange(clamp(value + (event.key === increase ? 1 : -1) * direction * (event.shiftKey ? 40 : 16)))
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      onChange(event.key === 'Home' ? min : max)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      onReset()
    }
  }

  return <div
    role="separator"
    tabIndex={0}
    aria-label={label}
    aria-controls={controls}
    aria-orientation={orientation}
    aria-valuemin={Math.round(min)}
    aria-valuemax={Math.round(max)}
    aria-valuenow={Math.round(value)}
    aria-valuetext={`${Math.round(value)} pixels`}
    title="Drag to resize · Arrow keys to adjust · Double-click to reset"
    className={`resize-handle resize-handle--${orientation} ${dragging ? 'is-resizing' : ''}`}
    onKeyDown={handleKeyDown}
    onDoubleClick={onReset}
    onPointerDown={(event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.currentTarget.focus()
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { pointerId: event.pointerId, start: orientation === 'vertical' ? event.clientX : event.clientY, value }
      setDragging(true)
    }}
    onPointerMove={(event) => {
      const current = drag.current
      if (!current || current.pointerId !== event.pointerId) return
      const position = orientation === 'vertical' ? event.clientX : event.clientY
      onChange(clamp(current.value + (position - current.start) * direction))
    }}
    onPointerUp={(event) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    }}
    onLostPointerCapture={() => { drag.current = null; setDragging(false) }}
    onPointerCancel={() => { drag.current = null; setDragging(false) }}
  />
}
