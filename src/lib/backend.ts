import { invoke } from '@tauri-apps/api/core'
import { demoBootstrap, demoMessages } from './demo'
import type { BootstrapState, Message } from '../types'

export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

let browserBootstrap: BootstrapState = structuredClone(demoBootstrap)
let browserMessages: Message[] = structuredClone(demoMessages)

async function call<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error('Desktop bridge is unavailable in browser preview')
  return invoke<T>(name, args)
}

export async function bootstrap(): Promise<BootstrapState> {
  if (!isTauri()) return structuredClone(browserBootstrap)
  return call<BootstrapState>('bootstrap')
}

export async function getMessages(conversationId: string): Promise<Message[]> {
  if (!isTauri()) return browserMessages.filter((m) => m.conversation_id === conversationId)
  return call<Message[]>('get_messages', { conversationId })
}

export async function createConversation(): Promise<{ conversation: BootstrapState['conversations'][number] }> {
  return call('create_conversation')
}

export async function deleteConversation(conversationId: string): Promise<void> {
  if (!isTauri()) return
  await call('delete_conversation', { conversationId })
}

export async function setMessageIncluded(messageId: string, included: boolean): Promise<void> {
  if (!isTauri()) return
  await call('set_message_included', { messageId, included })
}

export async function deleteBranch(messageId: string): Promise<void> {
  if (!isTauri()) return
  await call('delete_branch', { messageId })
}
