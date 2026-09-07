import { useState } from 'react'
import type { ProviderConfig } from '../../types'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'

const fieldClass = 'field'
const labelClass = 'field-label'

export function ProviderSettings({ provider, onSave, onClose }: { provider: ProviderConfig; onSave: (provider: ProviderConfig) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState<ProviderConfig>({ ...provider })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const update = <K extends keyof ProviderConfig>(key: K, value: ProviderConfig[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const endpointName = draft.protocol === 'openai_responses' ? '/responses' : '/chat/completions'

  const handleSave = async () => {
    if (!draft.base_url.trim() || !draft.model.trim()) return
    setSaveError(null)
    setSaving(true)
    try {
      await onSave(draft)
    } catch (reason) {
      setSaveError(String(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="Provider settings" onClose={onClose} wide footer={
      <>
        <span className="mr-auto text-xs text-muted-foreground max-sm:hidden">Stored on this device</span>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" className="min-w-28" disabled={saving || !draft.base_url.trim() || !draft.model.trim()} onClick={() => void handleSave()}>{saving ? 'Saving…' : 'Save locally'}</Button>
      </>
    }>
      <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
        <label className={labelClass}>Provider name<input className={fieldClass} value={draft.name} onChange={(event) => update('name', event.target.value)} /></label>
        <label className={labelClass}>Protocol<select className={fieldClass} value={draft.protocol} onChange={(event) => update('protocol', event.target.value as ProviderConfig['protocol'])}><option value="openai_chat_completions">OpenAI Chat Completions</option><option value="openai_responses">OpenAI Responses API</option></select></label>
        <label className={`${labelClass} col-span-2 max-sm:col-span-1`}>Base URL<input className={fieldClass} value={draft.base_url} onChange={(event) => update('base_url', event.target.value)} placeholder="https://example.com/v1" /><span className="font-normal leading-4 text-muted-foreground">Endpoint: {endpointName}</span></label>
        <label className={`${labelClass} col-span-2 max-sm:col-span-1`}>API key<input className={fieldClass} type="password" autoComplete="off" value={draft.api_key} onChange={(event) => update('api_key', event.target.value)} /></label>
        <label className={labelClass}>Model ID<input className={fieldClass} value={draft.model} onChange={(event) => update('model', event.target.value)} /></label>
        <label className={labelClass}>Context window<input className={fieldClass} type="number" min={1} value={draft.context_window} onChange={(event) => update('context_window', Number(event.target.value))} /></label>
        <label className={labelClass}>Max output<input className={fieldClass} type="number" min={1} value={draft.max_output_tokens} onChange={(event) => update('max_output_tokens', Number(event.target.value))} /></label>
        <label className={labelClass}>Temperature<input className={fieldClass} type="number" step="0.1" value={draft.temperature ?? ''} onChange={(event) => update('temperature', event.target.value === '' ? null : Number(event.target.value))} /></label>
        <label className={`${labelClass} col-span-2 max-sm:col-span-1`}>System text<textarea className={fieldClass} rows={5} value={draft.system_text} onChange={(event) => update('system_text', event.target.value)} /></label>
      </div>
      <details className="mt-5 rounded-xl border border-border/70 p-4">
        <summary className="cursor-pointer text-sm font-medium">Advanced settings</summary>
        <div className="mt-4 grid grid-cols-2 gap-4 max-sm:grid-cols-1">
          <label className={labelClass}>API key storage<select className={fieldClass} value={draft.api_key_storage} onChange={(event) => update('api_key_storage', event.target.value as ProviderConfig['api_key_storage'])}><option value="plain_portable">Plain portable configuration</option><option value="windows_dpapi" disabled>Windows DPAPI (planned)</option></select></label>
          <label className={`${labelClass} col-span-2 max-sm:col-span-1`}>Context separator<textarea className={fieldClass} rows={3} value={draft.context_separator} onChange={(event) => update('context_separator', event.target.value)} /></label>
          <label className={`${labelClass} col-span-2 max-sm:col-span-1`}>Optional raw JSON overrides<textarea className={`${fieldClass} font-mono`} rows={6} value={draft.raw_json_overrides} onChange={(event) => update('raw_json_overrides', event.target.value)} /></label>
        </div>
      </details>
      {saveError && <p className="mb-0 mt-3 break-words text-xs text-destructive" role="alert">{saveError}</p>}
    </Modal>
  )
}
