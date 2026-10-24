import type { ImageAttachment, Message, ProviderProtocol, Reasoning } from '../types'
import { imageContent } from './images'

export const interventionTool = {
  name: 'cerachat_intervention',
  description: 'Pause the current work for operator feedback. The result contains the next user intervention. Continue the work using that feedback.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
}

export interface HistoryMessage {
  role: string
  content: string
  images: ImageAttachment[]
  reasoning_content?: string
  intervention_call_id?: string
}

export function historyMessage(message: Message): HistoryMessage {
  const result: HistoryMessage = { role: message.role, content: message.content, images: message.images ?? [] }
  if (message.role !== 'assistant') return result
  const selected = (message.reasoning?.parts ?? []).filter((part) => part.include_next && part.text)
  const mode = message.reasoning?.replay_mode ?? 'native'
  const raw = selected.filter((part) => part.kind === 'text')
  // Concatenate raw chunks verbatim: inserted separators change provider reasoning.
  if (mode !== 'text' && raw.length) result.reasoning_content = raw.map((part) => part.text).join('')
  const notes = selected.filter((part) => mode === 'text' || part.kind === 'summary').map((part) => {
    const label = part.kind === 'summary' ? 'Selected reasoning summary' : 'Assistant working notes'
    return `[${label}]\n${part.text}\n[/${label}]`
  })
  result.content = [...notes, message.content].filter(Boolean).join('\n\n')
  if (mode === 'interleaved' && selected.length) {
    if (!raw.length || selected.some((part) => part.kind !== 'text') || message.reasoning?.encrypted) {
      throw new Error('Interleaved mock requires raw reasoning text without protected state or summaries. Choose Native raw or Assistant notes.')
    }
    result.intervention_call_id = `call_cera_${message.id.replace(/-/g, '')}`
  }
  return result
}

// Always emit a complete pair, even if a history filter removes the next user.
export function interleaveHistory(messages: HistoryMessage[]): HistoryMessage[] {
  const result: HistoryMessage[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    result.push(message)
    if (message.role !== 'assistant' || !message.intervention_call_id) continue
    const next = messages[index + 1]
    if (next?.role === 'user' && next.images.length) throw new Error('Interleaved mock supports text interventions only. Choose Native raw to send images.')
    const intervention = next?.role === 'user' ? next.content : 'Continue.'
    result.push({ role: 'tool', content: intervention, images: [], intervention_call_id: message.intervention_call_id })
    if (next?.role === 'user') index++
  }
  return result
}

export function wireHistory(messages: HistoryMessage[], protocol: ProviderProtocol): Record<string, unknown>[] {
  return messages.flatMap((message): Record<string, unknown>[] => {
    const id = message.intervention_call_id
    if (message.role === 'tool') return [protocol === 'openai_responses'
      ? { type: 'function_call_output', call_id: id, output: message.content }
      : { role: 'tool', tool_call_id: id, content: message.content }]
    const content = imageContent(message.content, message.images, protocol)
    if (protocol === 'openai_chat_completions') return [{ role: message.role, content,
      ...(message.reasoning_content !== undefined ? { reasoning_content: message.reasoning_content } : {}),
      ...(id ? { tool_calls: [{ id, type: 'function', function: { name: interventionTool.name, arguments: '{}' } }] } : {}),
    }]
    return [
      ...(message.reasoning_content !== undefined ? [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: message.reasoning_content }] }] : []),
      ...(message.content || message.images.length || !id ? [{ role: message.role, content }] : []),
      ...(id ? [{ type: 'function_call', call_id: id, name: interventionTool.name, arguments: '{}' }] : []),
    ]
  })
}

export function auditHistory(message: HistoryMessage): string {
  return `[${message.role}]\n${message.reasoning_content !== undefined ? `[reasoning_content]\n${message.reasoning_content}\n[/reasoning_content]\n` : ''}${message.content}${message.intervention_call_id ? `\n[${message.role === 'tool' ? 'tool_result' : interventionTool.name}: ${message.intervention_call_id}]` : ''}${message.images.map((image) => `\n[image: ${image.name}]`).join('')}`
}

export function historyContent(message: Message): string {
  try { return auditHistory(historyMessage(message)) } catch { return message.content }
}

export function editedReasoning(original: Reasoning | null | undefined, draft: Reasoning | null): Reasoning | null {
  if (!draft || !draft.parts.length) return null
  if (JSON.stringify(draft) === JSON.stringify(original)) return draft
  return { ...draft, tokens: null, encrypted: false, edited: true }
}

export function mergeReasoning(current: Reasoning | null, delta?: Reasoning | null): Reasoning | null {
  if (!delta) return current
  const parts = (current?.parts ?? []).map((part) => ({ ...part }))
  for (const part of delta.parts) {
    const existing = parts.find((item) => item.id === part.id)
    if (existing) existing.text += part.text
    else parts.push({ ...part })
  }
  return { ...current, parts, tokens: delta.tokens ?? current?.tokens ?? null, encrypted: Boolean(current?.encrypted || delta.encrypted) }
}
