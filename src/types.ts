export type Role = 'user' | 'assistant'
export type HistoryMode = 'full' | 'last10' | 'since_here' | 'selected' | 'no_history'
export type WrapperMode = 'raw' | 'labeled'
export type InsertAt = 'before_current' | 'inside_current' | 'before_history' | 'system'
export type KeyStorageMode = 'plain_portable' | 'windows_dpapi'

export interface Conversation { id: string; title: string; created_at: number; updated_at: number }
export interface Message { id: string; conversation_id: string; parent_id: string | null; role: Role; content: string; include_next: boolean; created_at: number }
export interface ProviderConfig { id: string; name: string; protocol: 'openai_chat_completions'; base_url: string; api_key: string; api_key_storage: KeyStorageMode; model: string; context_window: number; max_output_tokens: number; system_text: string; temperature: number | null; raw_json_overrides: string; context_separator: string }
export interface WorkspaceSource { id: string; display_name: string; origin_path: string; archive_path: string | null; blob_hash: string; original_size: number; line_count: number; created_at: number }
export interface ContextSlice { id: string; source_id: string; source_name: string; range_type: 'all' | 'lines' | 'chars'; start_pos: number | null; end_pos: number | null; enabled: boolean; sort_order: number; wrapper: WrapperMode; insert_at: InsertAt; estimated_tokens: number }
export interface SourceLines { source_id: string; start_line: number; total_lines: number; lines: string[] }
export interface RequestBreakdown { system_tokens: number; history_tokens: number; workspace_tokens: number; input_tokens: number; estimated_input_tokens: number; configured_context: number; max_output_tokens: number }
export interface RequestPreview { request_json: string; compiled_prompt: string; request_sha256: string; breakdown: RequestBreakdown }
export interface BootstrapState { conversations: Conversation[]; provider: ProviderConfig; sources: WorkspaceSource[]; slices: ContextSlice[]; data_dir?: string }
export interface StreamPayload { request_id: string; conversation_id: string; kind: 'started' | 'delta' | 'done' | 'error'; text?: string; error?: string; assistant_message?: Message; user_message?: Message }
export interface CompileRequestArgs { conversationId: string; parentId: string | null; input: string; historyMode: HistoryMode; sinceMessageId?: string | null }
export interface AddSliceArgs { sourceId: string; rangeType: 'all' | 'lines' | 'chars'; startPos?: number | null; endPos?: number | null; wrapper: WrapperMode; insertAt: InsertAt }
export interface UpdateSliceArgs { sliceId: string; enabled?: boolean; wrapper?: WrapperMode; insertAt?: InsertAt; sortOrder?: number }
