import { useEffect, useState } from 'react'

export function usePanelSize(name: string, defaultSize: number) {
  const key = `cerachat.layout.${name}.v1`
  const [size, setSize] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(key))
      return Number.isFinite(saved) && saved > 0 ? saved : defaultSize
    } catch { return defaultSize }
  })
  useEffect(() => {
    try { localStorage.setItem(key, String(size)) } catch { /* Resizing also works when storage is unavailable. */ }
  }, [key, size])
  return [size, setSize] as const
}

export function useViewportSize() {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  useEffect(() => {
    const update = () => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  return size
}

// Shrink the visible sidebars together, keeping their minimums and the chat readable.
export function fitSidebars(available: number, threads: number, context: number) {
  const minimum = (threads ? 200 : 0) + (context ? 300 : 0)
  const extra = Math.max(0, threads + context - minimum)
  const scale = extra ? Math.min(1, Math.max(0, available - minimum) / extra) : 1
  return {
    threads: threads ? 200 + (threads - 200) * scale : 0,
    context: context ? 300 + (context - 300) * scale : 0,
  }
}
