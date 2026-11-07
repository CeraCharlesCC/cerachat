/** Main-thread RPC for the single-owner SQLite OPFS worker. */
import type { WorkspaceSource } from '../types'

type SqlBind = (string | number | null | Uint8Array)[]
export type Statement = { sql: string; bind?: SqlBind }
interface Reply { id: number; ok: boolean; result?: unknown; error?: string }

let worker: Worker | undefined
let sequence = 0
const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
let initializationError: Error | null = null

function request<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  if (initializationError) return Promise.reject(initializationError)
  if (!worker) {
    worker = new Worker(new URL('./browserDb.worker.ts', import.meta.url), { type: 'module', name: 'cerachat-sqlite' })
    worker.onmessage = ({ data }: MessageEvent<Reply>) => {
      const pending = waiting.get(data.id)
      if (!pending) return
      waiting.delete(data.id)
      if (data.ok) pending.resolve(data.result)
      else pending.reject(new Error(data.error ?? 'Unknown browser storage error'))
    }
    worker.onerror = (event) => {
      initializationError = new Error(`Browser database Worker failed: ${event.message}`)
      for (const pending of waiting.values()) pending.reject(initializationError)
      waiting.clear()
      worker?.terminate()
      worker = undefined
    }
  }
  const id = ++sequence
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve: (value) => resolve(value as T), reject })
    worker!.postMessage({ id, op, args })
  })
}

export const storageReady = () => request<{ version: number; vfs: string }>('health')
export const query = <T>(sql: string, bind: SqlBind = []) => request<T[]>('query', { sql, bind })
export const execute = (sql: string, bind: SqlBind = []) => request<void>('execute', { sql, bind })
export const transaction = (statements: Statement[]) => request<void>('batch', { statements })
export const addSource = (id: string, conversationId: string, name: string, text: string) =>
  request<WorkspaceSource>('addSource', { id, conversationId, name, text })
export const getSourceText = (sourceId: string) => request<string>('sourceText', { sourceId })
export const exportSnapshot = () => request<Uint8Array>('export')
export const importSnapshot = (bytes: Uint8Array) => request<void>('import', { bytes })
