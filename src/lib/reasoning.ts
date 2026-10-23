import type { Message, Reasoning } from '../types'

// Visible reasoning is replayed as labeled assistant text, never as fabricated
// provider-native reasoning items or encrypted reasoning state.
export function historyContent(message: Message): string {
  if (message.role !== 'assistant') return message.content
  const selected = (message.reasoning?.parts ?? [])
    .filter((part) => part.include_next && part.text.length > 0)
    .map((part) => {
      const label = part.kind === 'summary' ? 'Selected reasoning summary' : 'Selected reasoning text'
      return `[${label}]\n${part.text}\n[/${label}]`
    })
  return [...selected, message.content].filter(Boolean).join('\n\n')
}

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
