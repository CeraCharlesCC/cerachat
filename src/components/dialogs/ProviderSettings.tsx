import { useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { deleteModel, deleteProvider, saveModel, saveProvider } from '../../lib/backend'
import { makeUniqueModelId, validateModel, validateProvider } from '../../lib/catalog'
import type { ModelProfile, ProviderCatalog, ProviderProfile } from '../../types'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'

const fieldClass = 'field'
const labelClass = 'field-label'

const newProvider = (): ProviderProfile => ({
  id: `provider-${crypto.randomUUID().slice(0, 8)}`,
  name: 'New provider',
  protocol: 'openai_chat_completions',
  base_url: 'https://api.openai.com/v1',
  api_key_storage: 'plain_portable',
  system_text: '',
  temperature: null,
  raw_json_overrides: '{}',
  context_separator: '\n\n──────── USER INPUT ────────\n\n',
})

interface ModelDraft {
  provider_id: string
  model_id: string
  name: string
  context_window: string
  max_output_tokens: string
}

function toModelDraft(model: ModelProfile): ModelDraft {
  return { ...model, context_window: String(model.context_window), max_output_tokens: String(model.max_output_tokens) }
}

function blankModel(providerId: string): ModelDraft {
  return { provider_id: providerId, model_id: '', name: '', context_window: '131072', max_output_tokens: '16384' }
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export interface ProviderSettingsProps {
  catalog: ProviderCatalog
  onCatalogChange: (catalog: ProviderCatalog) => void
  onClose: () => void
}

export function ProviderSettings({ catalog, onCatalogChange, onClose }: ProviderSettingsProps) {
  const firstProvider = catalog.providers[0] ?? null
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(firstProvider?.id ?? null)
  const [providerDraft, setProviderDraft] = useState<ProviderProfile | null>(firstProvider ? { ...firstProvider } : null)
  const [providerPersisted, setProviderPersisted] = useState(Boolean(firstProvider))
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [modelDraft, setModelDraft] = useState<ModelDraft | null>(null)
  const [modelPersisted, setModelPersisted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const models = useMemo(
    () => selectedProviderId ? catalog.models.filter((model) => model.provider_id === selectedProviderId) : [],
    [catalog.models, selectedProviderId],
  )

  const chooseProvider = (provider: ProviderProfile) => {
    setSelectedProviderId(provider.id)
    setProviderDraft({ ...provider })
    setProviderPersisted(true)
    setApiKey('')
    setClearApiKey(false)
    setModelDraft(null)
    setModelPersisted(false)
    setError(null)
  }

  const addProvider = () => {
    const provider = newProvider()
    setSelectedProviderId(provider.id)
    setProviderDraft(provider)
    setProviderPersisted(false)
    setApiKey('')
    setClearApiKey(false)
    setModelDraft(null)
    setModelPersisted(false)
    setError(null)
  }

  const updateProvider = <K extends keyof ProviderProfile>(key: K, value: ProviderProfile[K]) => {
    setProviderDraft((current) => current ? { ...current, [key]: value } : current)
  }

  const handleSaveProvider = async () => {
    if (!providerDraft || busy) return
    setError(null)
    setBusy(true)
    try {
      if (!providerPersisted && catalog.providers.some((provider) => provider.id === providerDraft.id)) {
        throw new Error(`Provider ID "${providerDraft.id}" already exists`)
      }
      if (!providerDraft.name.trim()) throw new Error('Provider name must not be empty')
      validateProvider(providerDraft)
      const keyUpdate = providerPersisted ? (clearApiKey ? '' : apiKey === '' ? null : apiKey) : apiKey
      const next = await saveProvider(providerDraft, keyUpdate)
      onCatalogChange(next)
      setSelectedProviderId(providerDraft.id)
      setProviderPersisted(true)
      setApiKey('')
      setClearApiKey(false)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteProvider = async () => {
    if (!providerDraft || !providerPersisted || busy) return
    if (!window.confirm(`Delete ${providerDraft.name || providerDraft.id} and all of its models?`)) return
    setError(null)
    setBusy(true)
    try {
      const next = await deleteProvider(providerDraft.id)
      onCatalogChange(next)
      const nextProvider = next.providers[0] ?? null
      setSelectedProviderId(nextProvider?.id ?? null)
      setProviderDraft(nextProvider ? { ...nextProvider } : null)
      setProviderPersisted(Boolean(nextProvider))
      setApiKey('')
      setClearApiKey(false)
      setModelDraft(null)
      setModelPersisted(false)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const chooseModel = (model: ModelProfile) => {
    setModelDraft(toModelDraft(model))
    setModelPersisted(true)
    setError(null)
  }

  const addModel = () => {
    if (!providerDraft || !providerPersisted) return
    setModelDraft(blankModel(providerDraft.id))
    setModelPersisted(false)
    setError(null)
  }

  const updateModel = <K extends keyof ModelDraft>(key: K, value: ModelDraft[K]) => {
    setModelDraft((current) => current ? { ...current, [key]: value } : current)
  }

  const handleSaveModel = async () => {
    if (!modelDraft || busy) return
    setError(null)
    setBusy(true)
    try {
      const model: ModelProfile = {
        provider_id: modelDraft.provider_id,
        model_id: modelDraft.model_id,
        name: modelDraft.name,
        context_window: Number(modelDraft.context_window),
        max_output_tokens: Number(modelDraft.max_output_tokens),
      }
      validateModel(model)
      if (!modelPersisted && catalog.models.some((item) => item.provider_id === model.provider_id && item.model_id === model.model_id)) {
        throw new Error(`Model "${makeUniqueModelId(model.provider_id, model.model_id)}" already exists`)
      }
      const next = await saveModel(model)
      onCatalogChange(next)
      setModelDraft(toModelDraft(model))
      setModelPersisted(true)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteModel = async () => {
    if (!modelDraft || !modelPersisted || busy) return
    const uniqueId = makeUniqueModelId(modelDraft.provider_id, modelDraft.model_id)
    if (!window.confirm(`Delete model ${uniqueId}?`)) return
    setError(null)
    setBusy(true)
    try {
      const next = await deleteModel(modelDraft.provider_id, modelDraft.model_id)
      onCatalogChange(next)
      setModelDraft(null)
      setModelPersisted(false)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const endpointName = providerDraft?.protocol === 'openai_responses' ? '/responses' : '/chat/completions'

  return (
    <Modal title="Provider settings" onClose={onClose} wide footer={
      <>
        <span className="mr-auto text-xs text-muted-foreground max-sm:hidden">Stored locally · no provider requests</span>
        <Button variant="primary" onClick={onClose}>Done</Button>
      </>
    }>
      <div className="grid min-h-[520px] grid-cols-[190px_minmax(0,1fr)] gap-5 max-sm:grid-cols-1">
        <aside className="flex min-w-0 flex-col border-r border-border/70 pr-4 max-sm:border-b max-sm:border-r-0 max-sm:pb-4 max-sm:pr-0">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Providers</h3>
            <Button size="icon" variant="ghost" aria-label="Add provider" title="Add provider" onClick={addProvider} disabled={busy}><Plus size={15} /></Button>
          </div>
          <div className="flex flex-col gap-1">
            {catalog.providers.map((provider) => (
              <button key={provider.id} type="button" disabled={busy} className={`min-w-0 rounded-lg px-2.5 py-2 text-left text-xs transition-colors disabled:opacity-50 ${selectedProviderId === provider.id && providerPersisted ? 'bg-accent font-semibold text-accent-foreground' : 'hover:bg-accent/70'}`} onClick={() => chooseProvider(provider)}>
                <span className="block truncate">{provider.name || provider.id}</span>
                <span className="block truncate text-[10px] font-normal text-muted-foreground">{provider.id}</span>
              </button>
            ))}
            {!catalog.providers.length && !providerDraft && <p className="my-3 text-xs leading-5 text-muted-foreground">No providers configured.</p>}
          </div>
          <Button className="mt-3 w-full" size="sm" variant="outline" onClick={addProvider} disabled={busy}><Plus size={14} />Add provider</Button>
        </aside>

        <div className="min-w-0">
          {!providerDraft ? (
            <div className="grid min-h-72 place-items-center rounded-xl border border-dashed border-border p-6 text-center">
              <div><p className="m-0 text-sm font-medium">Add a provider to begin</p><p className="mb-0 mt-1 text-xs text-muted-foreground">Providers and models are configured manually.</p></div>
            </div>
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between gap-3">
                <div><h3 className="m-0 text-sm font-semibold">{providerPersisted ? 'Provider details' : 'New provider'}</h3><p className="mb-0 mt-1 text-xs text-muted-foreground">The provider ID cannot change after the first save.</p></div>
                {providerPersisted && <Button size="sm" variant="destructive" onClick={() => void handleDeleteProvider()} disabled={busy}><Trash2 size={14} />Delete</Button>}
              </div>
              <fieldset disabled={busy} className="m-0 grid min-w-0 grid-cols-2 gap-4 border-0 p-0 max-sm:grid-cols-1">
                <label className={labelClass}>Provider ID<input className={fieldClass} value={providerDraft.id} readOnly={providerPersisted} aria-readonly={providerPersisted} onChange={(event) => updateProvider('id', event.target.value)} /></label>
                <label className={labelClass}>Provider name<input className={fieldClass} value={providerDraft.name} onChange={(event) => updateProvider('name', event.target.value)} /></label>
                <label className={labelClass}>Protocol<select className={fieldClass} value={providerDraft.protocol} onChange={(event) => updateProvider('protocol', event.target.value as ProviderProfile['protocol'])}><option value="openai_chat_completions">OpenAI Chat Completions</option><option value="openai_responses">OpenAI Responses API</option></select></label>
                <label className={labelClass}>API key storage<select className={fieldClass} value={providerDraft.api_key_storage} onChange={(event) => updateProvider('api_key_storage', event.target.value as ProviderProfile['api_key_storage'])}><option value="plain_portable">Plain portable configuration</option><option value="windows_dpapi" disabled>Windows DPAPI (planned)</option></select></label>
                <label className={`${labelClass} col-span-2 max-sm:col-span-1`}>Base URL<input className={fieldClass} value={providerDraft.base_url} onChange={(event) => updateProvider('base_url', event.target.value)} placeholder="https://api.openai.com/v1" /><span className="font-normal leading-4 text-muted-foreground">Endpoint: {endpointName}</span></label>
                <label className={`${labelClass} col-span-2 max-sm:col-span-1`}>API key<input className={fieldClass} type="password" autoComplete="new-password" value={apiKey} disabled={clearApiKey} placeholder={providerPersisted ? 'Leave empty to keep the stored key' : 'Optional'} onChange={(event) => { setApiKey(event.target.value); setClearApiKey(false) }} /><span className="font-normal leading-4 text-muted-foreground">Stored keys are never shown here.</span></label>
                {providerPersisted && <div className="col-span-2 flex items-center gap-3 max-sm:col-span-1"><Button size="sm" variant={clearApiKey ? 'destructive' : 'outline'} onClick={() => { setClearApiKey((current) => !current); setApiKey('') }}>{clearApiKey ? 'Key will be cleared' : 'Clear stored key'}</Button>{clearApiKey && <span className="text-xs text-destructive">Save provider to apply.</span>}</div>}
                <label className={labelClass}>Temperature<input className={fieldClass} type="number" step="0.1" value={providerDraft.temperature ?? ''} onChange={(event) => updateProvider('temperature', event.target.value === '' ? null : Number(event.target.value))} placeholder="Provider default" /></label>
                <label className={`${labelClass} col-span-2 max-sm:col-span-1`}>System text<textarea className={fieldClass} rows={4} value={providerDraft.system_text} onChange={(event) => updateProvider('system_text', event.target.value)} /></label>
                <label className={`${labelClass} col-span-2 max-sm:col-span-1`}>Context separator<textarea className={`${fieldClass} font-mono`} rows={3} value={providerDraft.context_separator} onChange={(event) => updateProvider('context_separator', event.target.value)} /></label>
                <label className={`${labelClass} col-span-2 max-sm:col-span-1`}>Raw JSON overrides<textarea className={`${fieldClass} font-mono`} rows={5} value={providerDraft.raw_json_overrides} onChange={(event) => updateProvider('raw_json_overrides', event.target.value)} /></label>
              </fieldset>
              <div className="mt-4 flex justify-end"><Button variant="primary" onClick={() => void handleSaveProvider()} disabled={busy}>{busy ? 'Saving…' : 'Save provider'}</Button></div>

              <section className="mt-6 border-t border-border/70 pt-5">
                <div className="mb-3 flex items-center justify-between gap-3"><div><h3 className="m-0 text-sm font-semibold">Models</h3><p className="mb-0 mt-1 text-xs text-muted-foreground">Add API model IDs manually.</p></div><Button size="sm" variant="outline" onClick={addModel} disabled={busy || !providerPersisted}><Plus size={14} />Add model</Button></div>
                {!providerPersisted && <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">Save this provider before adding models.</p>}
                {providerPersisted && (
                  <div className="grid grid-cols-[minmax(120px,0.7fr)_minmax(0,1.3fr)] gap-4 max-sm:grid-cols-1">
                    <div className="flex min-w-0 flex-col gap-1">
                      {models.map((model) => {
                        const id = makeUniqueModelId(model.provider_id, model.model_id)
                        const selected = modelDraft && modelPersisted && makeUniqueModelId(modelDraft.provider_id, modelDraft.model_id) === id
                        return <button key={id} type="button" disabled={busy} className={`min-w-0 rounded-lg px-2.5 py-2 text-left text-xs disabled:opacity-50 ${selected ? 'bg-accent font-semibold' : 'hover:bg-accent/70'}`} onClick={() => chooseModel(model)}><span className="block truncate">{model.name || model.model_id}</span><span className="block truncate text-[10px] font-normal text-muted-foreground">{model.model_id}</span></button>
                      })}
                      {!models.length && <p className="my-2 text-xs text-muted-foreground">No models saved.</p>}
                    </div>
                    <div className="min-w-0">
                      {modelDraft ? (
                        <fieldset disabled={busy} className="m-0 grid min-w-0 grid-cols-2 gap-3 border-0 p-0 max-sm:grid-cols-1">
                          <label className={`${labelClass} col-span-2 max-sm:col-span-1`}>Model ID<input className={fieldClass} value={modelDraft.model_id} readOnly={modelPersisted} aria-readonly={modelPersisted} onChange={(event) => updateModel('model_id', event.target.value)} placeholder="gpt-4.1" /></label>
                          <label className={`${labelClass} col-span-2 max-sm:col-span-1`}>Display name (optional)<input className={fieldClass} value={modelDraft.name} onChange={(event) => updateModel('name', event.target.value)} placeholder="Uses model ID when empty" /></label>
                          <label className={labelClass}>Context window<input className={fieldClass} type="number" min="1" max="4294967295" step="1" value={modelDraft.context_window} onChange={(event) => updateModel('context_window', event.target.value)} /></label>
                          <label className={labelClass}>Max output tokens<input className={fieldClass} type="number" min="1" max="4294967295" step="1" value={modelDraft.max_output_tokens} onChange={(event) => updateModel('max_output_tokens', event.target.value)} /></label>
                          <div className="col-span-2 flex justify-end gap-2 max-sm:col-span-1">{modelPersisted && <Button variant="destructive" onClick={() => void handleDeleteModel()} disabled={busy}><Trash2 size={14} />Delete model</Button>}<Button variant="primary" onClick={() => void handleSaveModel()} disabled={busy}>{busy ? 'Saving…' : 'Save model'}</Button></div>
                        </fieldset>
                      ) : (
                        <div className="grid min-h-36 place-items-center rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">Select a model or add one.</div>
                      )}
                    </div>
                  </div>
                )}
              </section>
            </>
          )}
          {error && <p className="mb-0 mt-4 break-words rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">{error}</p>}
        </div>
      </div>
    </Modal>
  )
}
