import type { BootstrapState, ContextSlice, Message, ProviderConfig, RequestPreview, SourceLines, WorkspaceSource } from '../types'

const now = Date.now()
export const demoSources: WorkspaceSource[] = [
  { id: 'source-1', display_name: 'instructions.txt', origin_path: '/demo/instructions.txt', archive_path: null, blob_hash: '2a54d0d', original_size: 38912, line_count: 284, created_at: now },
  { id: 'source-2', display_name: 'source.zip / logs/debug.log', origin_path: '/demo/source.zip', archive_path: 'logs/debug.log', blob_hash: '8e17d10', original_size: 532480, line_count: 6402, created_at: now },
  { id: 'source-3', display_name: 'notes.md', origin_path: '/demo/notes.md', archive_path: null, blob_hash: '4187b21', original_size: 19456, line_count: 176, created_at: now },
]

export const demoSlices: ContextSlice[] = [
  { id: 'slice-1', source_id: 'source-1', source_name: 'instructions.txt', range_type: 'all', start_pos: null, end_pos: null, enabled: true, sort_order: 0, wrapper: 'raw', insert_at: 'before_current', estimated_tokens: 8140 },
  { id: 'slice-2', source_id: 'source-2', source_name: 'source.zip / logs/debug.log', range_type: 'lines', start_pos: 120, end_pos: 550, enabled: true, sort_order: 1, wrapper: 'labeled', insert_at: 'before_current', estimated_tokens: 12181 },
]

export const demoMessages: Message[] = [
  { id: 'u1', conversation_id: 'demo-chat', parent_id: null, role: 'user', content: 'Analyze the selected context and identify the likely cause of the failure.', include_next: true, created_at: now - 5000 },
  { id: 'a1', conversation_id: 'demo-chat', parent_id: 'u1', role: 'assistant', content: 'The selected log range points to an initialization-order problem. The request inspector is useful here because it makes the exact included context auditable before anything leaves the machine.', include_next: true, created_at: now - 4000 },
  { id: 'u2', conversation_id: 'demo-chat', parent_id: 'a1', role: 'user', content: 'Show me the smallest change that would make that deterministic.', include_next: true, created_at: now - 3000 },
  { id: 'a2', conversation_id: 'demo-chat', parent_id: 'u2', role: 'assistant', content: 'Move the initialization behind a single explicit state transition, and remove the implicit retry path. That keeps one user Send mapped to one outbound request.', include_next: true, created_at: now - 2000 },
  { id: 'a2-alt', conversation_id: 'demo-chat', parent_id: 'u2', role: 'assistant', content: 'A second branch can preserve the same parent while exploring a different response without mutating the original history.', include_next: true, created_at: now - 1000 },
]

export const demoBootstrap: BootstrapState = {
  conversations: [
    { id: 'demo-chat', title: 'Deterministic request architecture', created_at: now - 10000, updated_at: now },
    { id: 'chat-b', title: 'Large log review', created_at: now - 20000, updated_at: now - 15000 },
  ],
  provider_catalog: { providers: [], models: [], selected_model_id: null },
  sources: demoSources,
  slices: demoSlices,
}

export function demoSourceLines(sourceId: string, startLine: number, count: number): SourceLines {
  const source = demoSources.find((s) => s.id === sourceId) ?? demoSources[0]
  const total = source.line_count
  const lines = Array.from({ length: Math.min(count, Math.max(0, total - startLine + 1)) }, (_, i) => {
    const n = startLine + i
    if (sourceId === 'source-2') return `${String(n).padStart(5, '0')}  [worker] request-${Math.floor(n / 19)} state=${n % 7 === 0 ? 'retry-suppressed' : 'ready'} latency=${18 + (n % 41)}ms`
    return `Line ${n}: deterministic local context content for ${source.display_name}`
  })
  return { source_id: sourceId, start_line: startLine, total_lines: total, lines }
}

export function demoPreview(input: string, historyTokens: number, workspaceTokens: number, provider: ProviderConfig): RequestPreview {
  const compiledInput = `[compiled workspace context]${provider.context_separator}${input}`
  const request = provider.protocol === 'openai_responses'
    ? {
        model: provider.model,
        instructions: provider.system_text,
        input: [{ role: 'user', content: [{ type: 'input_text', text: compiledInput }] }],
        stream: true,
        max_output_tokens: provider.max_output_tokens,
      }
    : {
        model: provider.model,
        messages: [
          { role: 'system', content: provider.system_text },
          { role: 'user', content: compiledInput },
        ],
        stream: true,
        max_tokens: provider.max_output_tokens,
      }
  return {
    request_json: JSON.stringify(request, null, 2),
    compiled_prompt: compiledInput,
    request_sha256: 'browser-demo-preview',
    breakdown: {
      system_tokens: Math.ceil(provider.system_text.length / 4),
      history_tokens: historyTokens,
      workspace_tokens: workspaceTokens,
      input_tokens: Math.ceil(input.length / 4),
      estimated_input_tokens: historyTokens + workspaceTokens + Math.ceil(input.length / 4),
      configured_context: provider.context_window,
      max_output_tokens: provider.max_output_tokens,
    },
  }
}
