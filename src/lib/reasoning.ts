import type { Reasoning } from '../types'

export function mergeReasoning(current: Reasoning | null, delta?: Reasoning | null): Reasoning | null {
  if (!delta) return current
  const parts = (current?.parts ?? []).map((part) => ({ ...part }))
  for (const part of delta.parts) {
    const existing = parts.find((item) => item.id === part.id)
    if (existing) existing.text += part.text
    else parts.push({ ...part })
  }
  return { parts, tokens: delta.tokens ?? current?.tokens ?? null, encrypted: Boolean(current?.encrypted || delta.encrypted) }
}
