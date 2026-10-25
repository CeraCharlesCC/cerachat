import { useId, useMemo, useState } from 'react'
import { Box, Check, ChevronRight, HardDrive, Plus, Server, Trash2 } from 'lucide-react'
import { deleteModel, deleteProvider, saveModel, saveProvider } from '../../lib/backend'
import { makeUniqueModelId, validateModel, validateProvider } from '../../lib/catalog'
import type { ModelProfile, ProviderCatalog, ProviderProfile } from '../../types'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'
import { ModelParameters } from './ModelParameters'

const fieldClass = 'field'
const labelClass = 'field-label'

const newProvider = (): ProviderProfile => ({
  id: `provider-${crypto.randomUUID().slice(0, 8)}`,
  name: 'New provider',
  protocol: 'openai_chat_completions',
  base_url: 'https://api.openai.com/v1',
  api_key_storage: 'plain_portable',
  system_text: '',
  context_separator: '\n\n──────── USER INPUT ────────\n\n',
})

interface ModelDraft {
  image_input: boolean
  temperature: number | null
  raw_json_overrides: string
  provider_id: string
  model_id: string
  name: string
  context_window: string
  max_output_tokens: string
}

function toModelDraft(model: ModelProfile): ModelDraft {
  return { ...model, image_input: model.image_input ?? false, context_window: String(model.context_window), max_output_tokens: String(model.max_output_tokens) }
}

function blankModel(providerId: string): ModelDraft {
  return { image_input: false, provider_id: providerId, model_id: '', name: '', context_window: '131072', max_output_tokens: '16384', temperature: null, raw_json_overrides: '{}' }
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
  const [providerTab, setProviderTab] = useState('connection')
  const [modelTab, setModelTab] = useState('general')
  const [saved, setSaved] = useState(false)
  const panelId = useId()

  const models = useMemo(
    () => selectedProviderId ? catalog.models.filter((model) => model.provider_id === selectedProviderId) : [],
    [catalog.models, selectedProviderId],
  )

  const chooseProvider = (provider: ProviderProfile) => {
    setSelectedProviderId(provider.id)
    setProviderDraft({ ...provider })
    setProviderPersisted(true)
    setProviderTab('connection')
    setApiKey('')
    setClearApiKey(false)
    setModelDraft(null)
    setModelPersisted(false)
    setError(null)
    setSaved(false)
  }

  const addProvider = () => {
    const provider = newProvider()
    setSelectedProviderId(provider.id)
    setProviderDraft(provider)
    setProviderPersisted(false)
    setProviderTab('connection')
    setApiKey('')
    setClearApiKey(false)
    setModelDraft(null)
    setModelPersisted(false)
    setError(null)
    setSaved(false)
  }

  const updateProvider = <K extends keyof ProviderProfile>(key: K, value: ProviderProfile[K]) => {
    setSaved(false)
    setProviderDraft((current) => current ? { ...current, [key]: value } : current)
  }

  const handleSaveProvider = async () => {
    if (!providerDraft || busy) return
    setError(null)
    setBusy(true)
    setSaved(false)
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
      setSaved(true)
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
    setSaved(false)
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
    setSaved(false)
  }

  const addModel = () => {
    if (!providerDraft || !providerPersisted) return
    setModelTab('general')
    setModelDraft(blankModel(providerDraft.id))
    setModelPersisted(false)
    setError(null)
    setSaved(false)
  }

  const updateModel = <K extends keyof ModelDraft>(key: K, value: ModelDraft[K]) => {
    setSaved(false)
    setModelDraft((current) => current ? { ...current, [key]: value } : current)
  }

  const handleSaveModel = async () => {
    if (!modelDraft || busy) return
    setError(null)
    setBusy(true)
    setSaved(false)
    try {
      const model: ModelProfile = {
        image_input: modelDraft.image_input,
        provider_id: modelDraft.provider_id,
        model_id: modelDraft.model_id,
        name: modelDraft.name,
        context_window: Number(modelDraft.context_window),
        max_output_tokens: Number(modelDraft.max_output_tokens),
        temperature: modelDraft.temperature,
        raw_json_overrides: modelDraft.raw_json_overrides,
      }
      validateModel(model)
      if (!modelPersisted && catalog.models.some((item) => item.provider_id === model.provider_id && item.model_id === model.model_id)) {
        throw new Error(`Model "${makeUniqueModelId(model.provider_id, model.model_id)}" already exists`)
      }
      const next = await saveModel(model)
      onCatalogChange(next)
      setModelDraft(toModelDraft(model))
      setModelPersisted(true)
      setSaved(true)
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
    setSaved(false)
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

  const editingModel = modelDraft !== null
  const activeTab = editingModel ? modelTab : providerTab
  const tabs = editingModel
    ? [{ id: 'general', label: 'General' }, { id: 'parameters', label: 'Request parameters' }]
    : [{ id: 'connection', label: 'Connection' }, { id: 'prompt', label: 'Prompt & context' }]
  const setTab = editingModel ? setModelTab : setProviderTab
  const navigationClass = (selected: boolean) => `group flex w-full min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50 ${selected ? 'border-border bg-popover text-foreground shadow-sm' : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'}`

  return (
    <Modal title="Provider settings" onClose={onClose} wide className="h-[min(820px,90dvh)]" bodyClassName="min-h-0 flex-1 overflow-hidden" footer={
      <>
        {error && <p className="m-0 w-full break-words rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">{error}</p>}
        <span className="mr-auto flex items-center gap-2 text-xs text-muted-foreground" role="status">
          {saved ? <><Check size={14} />Changes saved</> : <><HardDrive size={14} /><span className="max-sm:sr-only">Stored locally · no provider requests</span></>}
        </span>
        <Button variant="outline" onClick={onClose}>Done</Button>
        {providerDraft && <Button variant="primary" onClick={() => void (editingModel ? handleSaveModel() : handleSaveProvider())} disabled={busy}>{busy ? 'Saving…' : editingModel ? 'Save model' : 'Save provider'}</Button>}
      </>
    }>
      <div className="grid h-full min-h-0 grid-cols-[220px_minmax(0,1fr)] max-sm:grid-cols-1 max-sm:grid-rows-[auto_minmax(0,1fr)]">
        <aside aria-label="Providers and models" className="panel flex min-h-0 min-w-0 flex-col gap-5 overflow-y-auto border-r border-border/70 p-3 max-sm:grid max-sm:max-h-44 max-sm:overflow-hidden max-sm:grid-cols-2 max-sm:gap-3 max-sm:border-b max-sm:border-r-0">
          <section className="min-w-0 max-sm:overflow-y-auto" aria-label="Providers">
            <div className="mb-2 flex items-center justify-between px-2 max-sm:sticky max-sm:top-0 max-sm:z-10 max-sm:bg-[var(--panel)]">
              <h3 className="m-0 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Providers</h3>
              <Button size="icon" variant="ghost" aria-label="Add provider" title="Add provider" onClick={addProvider} disabled={busy}><Plus size={15} /></Button>
            </div>
            <div className="flex flex-col gap-1">
              {catalog.providers.map((provider) => (
                <button key={provider.id} type="button" disabled={busy} aria-current={selectedProviderId === provider.id && providerPersisted && !editingModel ? 'true' : undefined} className={navigationClass(selectedProviderId === provider.id && providerPersisted && !editingModel)} onClick={() => chooseProvider(provider)}>
                  <Server size={15} className="shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{provider.name || provider.id}</span><span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{provider.id}</span></span>
                </button>
              ))}
              {!providerPersisted && providerDraft && <div className={navigationClass(!editingModel)}><Server size={15} /><span className="truncate text-xs">{providerDraft.name || 'New provider'}</span><span className="ml-auto text-[10px] text-muted-foreground">Draft</span></div>}
              {!catalog.providers.length && !providerDraft && <p className="px-2 text-xs leading-5 text-muted-foreground">No providers configured.</p>}
            </div>
            {!providerDraft && <Button className="mt-3 w-full" size="sm" variant="outline" onClick={addProvider} disabled={busy}><Plus size={14} />Add provider</Button>}
          </section>

          {providerDraft && <section className="min-w-0 border-t border-border/70 pt-3 max-sm:border-l max-sm:border-t-0 max-sm:pl-3 max-sm:pt-0 max-sm:overflow-y-auto" aria-label="Models">
            <div className="mb-2 flex items-center justify-between gap-2 px-2 max-sm:sticky max-sm:top-0 max-sm:z-10 max-sm:bg-[var(--panel)]">
              <div className="min-w-0"><h3 className="m-0 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Models <span className="ml-1 font-normal">{models.length}</span></h3><p className="mb-0 mt-1 truncate text-[11px] text-muted-foreground">{providerDraft.name}</p></div>
              <Button size="icon" variant="ghost" aria-label="Add model" title="Add model" onClick={addModel} disabled={busy || !providerPersisted}><Plus size={15} /></Button>
            </div>
            <div className="flex flex-col gap-1">
              {models.map((model) => {
                const id = makeUniqueModelId(model.provider_id, model.model_id)
                const selected = !!modelDraft && modelPersisted && makeUniqueModelId(modelDraft.provider_id, modelDraft.model_id) === id
                return <button key={id} type="button" disabled={busy} aria-current={selected ? 'true' : undefined} className={navigationClass(selected)} onClick={() => chooseModel(model)}>
                  <Box size={15} className="shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1"><span className="line-clamp-2 break-words text-xs font-medium" title={model.name || model.model_id}>{model.name || model.model_id}</span>{model.name && model.name !== model.model_id && <span className="mt-0.5 block truncate text-[11px] text-muted-foreground" title={model.model_id}>{model.model_id}</span>}</span>
                  {selected && <ChevronRight size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
                </button>
              })}
              {modelDraft && !modelPersisted && <div className={navigationClass(true)}><Box size={15} /><span className="text-xs">New model</span><span className="ml-auto text-[10px] text-muted-foreground">Draft</span></div>}
              {!models.length && <p className="px-2 text-xs leading-5 text-muted-foreground">{providerPersisted ? 'No models saved.' : 'Save this provider before adding models.'}</p>}
            </div>
          </section>}
        </aside>

        {!providerDraft ? (
          <div className="grid place-items-center p-8 text-center">
            <div><Server size={28} className="mx-auto mb-4 text-muted-foreground" /><h3 className="m-0 text-base font-semibold">Add your first provider</h3><p className="mb-5 mt-2 max-w-64 text-sm leading-6 text-muted-foreground">Set up an API connection, then add the models you want to use.</p><Button variant="primary" onClick={addProvider}><Plus size={15} />Add provider</Button></div>
          </div>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-col">
            <div className="shrink-0 px-6 pt-5 max-sm:px-4 max-sm:pt-4">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="min-w-0"><p className="mb-1 mt-0 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{editingModel ? `${providerDraft.name} / Model` : 'Provider'}</p><h3 className="m-0 break-words text-lg font-semibold tracking-tight">{editingModel ? modelDraft.name || modelDraft.model_id || 'New model' : providerDraft.name || 'New provider'}</h3><p className="mb-0 mt-1 text-xs leading-5 text-muted-foreground">{editingModel ? 'Configure model capabilities and request defaults.' : 'Manage your API connection and shared instructions.'}</p></div>
                {(editingModel ? modelPersisted : providerPersisted) && <Button size="sm" variant="destructive" onClick={() => void (editingModel ? handleDeleteModel() : handleDeleteProvider())} disabled={busy}><Trash2 size={14} /><span className="max-sm:sr-only">{editingModel ? 'Delete model' : 'Delete'}</span></Button>}
              </div>
              <div role="tablist" aria-label={editingModel ? 'Model settings' : 'Provider details'} className="flex gap-5 border-b border-border">
                {tabs.map((tab, index) => <button key={tab.id} type="button" role="tab" id={`${panelId}-${tab.id}-tab`} aria-selected={activeTab === tab.id} aria-controls={`${panelId}-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1} className={`-mb-px border-b-2 pb-3 text-xs font-medium transition-colors ${activeTab === tab.id ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`} onClick={() => setTab(tab.id)} onKeyDown={(event) => {
                  const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null
                  if (next === null) return
                  event.preventDefault()
                  setTab(tabs[next].id)
                  document.getElementById(`${panelId}-${tabs[next].id}-tab`)?.focus()
                }}>{tab.label}</button>)}
              </div>
            </div>
            <div className="scroll-stable min-h-0 flex-1 overflow-y-auto px-6 py-5 max-sm:px-4" key={editingModel ? 'model' : 'provider'}>
              {modelDraft ? <>
                <div role="tabpanel" id={`${panelId}-general`} aria-labelledby={`${panelId}-general-tab`} hidden={modelTab !== 'general'}>
                  <fieldset disabled={busy} className="m-0 grid min-w-0 grid-cols-2 gap-5 border-0 p-0 max-sm:grid-cols-1">
                    <label className={`${labelClass} col-span-2 max-sm:col-span-1`}>Model ID<input className={`${fieldClass} font-mono`} aria-label="Model ID" value={modelDraft.model_id} readOnly={modelPersisted} aria-readonly={modelPersisted} onChange={(event) => updateModel('model_id', event.target.value)} placeholder="gpt-4.1" /><span className="font-normal leading-4 text-muted-foreground">The exact model ID accepted by the API. Fixed after saving.</span></label>
                    <label className={`${labelClass} col-span-2 max-sm:col-span-1`}>Display name (optional)<input className={fieldClass} value={modelDraft.name} onChange={(event) => updateModel('name', event.target.value)} placeholder="Uses model ID when empty" /></label>
                    <div className="col-span-2 mt-1 border-t border-border/70 pt-5 max-sm:col-span-1"><h4 className="m-0 text-sm font-medium">Token limits</h4><p className="mb-0 mt-1 text-xs leading-5 text-muted-foreground">Use the limits supported by this model and provider.</p></div>
                    <label className={labelClass}>Context window<input className={fieldClass} type="number" min="1" max="4294967295" step="1" value={modelDraft.context_window} onChange={(event) => updateModel('context_window', event.target.value)} /></label>
                    <label className={labelClass}>Max output tokens<input className={fieldClass} type="number" min="1" max="4294967295" step="1" value={modelDraft.max_output_tokens} onChange={(event) => updateModel('max_output_tokens', event.target.value)} /></label>
                    <label className="col-span-2 mt-1 flex items-start gap-3 rounded-xl border border-border bg-muted/30 p-4 text-xs max-sm:col-span-1"><input className="mt-0.5 size-3.5 shrink-0 accent-[var(--primary)]" type="checkbox" aria-label="Enable image input" checked={modelDraft.image_input} onChange={(event) => updateModel('image_input', event.target.checked)} /><span><span className="block font-medium">Enable image input</span><span className="mt-1 block leading-5 text-muted-foreground">Enable only if this service and model accept inline images. Off by default; model names do not determine support.</span></span></label>
                  </fieldset>
                </div>
                <div role="tabpanel" id={`${panelId}-parameters`} aria-labelledby={`${panelId}-parameters-tab`} hidden={modelTab !== 'parameters'}>
                  <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0"><ModelParameters key={`${modelDraft.provider_id}::${modelPersisted ? modelDraft.model_id : 'new'}`} model={modelDraft} protocol={catalog.providers.find((provider) => provider.id === modelDraft.provider_id)?.protocol ?? providerDraft.protocol} onChange={(parameters) => { setSaved(false); setModelDraft((current) => current ? { ...current, ...parameters } : current) }} /></fieldset>
                </div>
              </> : <>
                <div role="tabpanel" id={`${panelId}-connection`} aria-labelledby={`${panelId}-connection-tab`} hidden={providerTab !== 'connection'}>
                  <fieldset disabled={busy} className="m-0 grid min-w-0 grid-cols-2 gap-5 border-0 p-0 max-sm:grid-cols-1">
                    <label className={labelClass}>Provider name<input className={fieldClass} value={providerDraft.name} onChange={(event) => updateProvider('name', event.target.value)} /></label>
                    <label className={labelClass}>Provider ID<input className={`${fieldClass} font-mono read-only:text-muted-foreground`} aria-label="Provider ID" value={providerDraft.id} readOnly={providerPersisted} aria-readonly={providerPersisted} onChange={(event) => updateProvider('id', event.target.value)} /><span className="font-normal leading-4 text-muted-foreground">Fixed after the first save.</span></label>
                    <label className={labelClass}>Protocol<select className={fieldClass} value={providerDraft.protocol} onChange={(event) => updateProvider('protocol', event.target.value as ProviderProfile['protocol'])}><option value="openai_chat_completions">OpenAI Chat Completions</option><option value="openai_responses">OpenAI Responses API</option></select></label>
                    <label className={labelClass}>API key storage<select className={fieldClass} value={providerDraft.api_key_storage} onChange={(event) => updateProvider('api_key_storage', event.target.value as ProviderProfile['api_key_storage'])}><option value="plain_portable">Plain portable configuration</option><option value="windows_dpapi" disabled>Windows DPAPI (planned)</option></select></label>
                    <label className={`${labelClass} col-span-2 max-sm:col-span-1`}>Base URL<input className={`${fieldClass} font-mono`} value={providerDraft.base_url} onChange={(event) => updateProvider('base_url', event.target.value)} placeholder="https://api.openai.com/v1" /><span className="font-normal leading-4 text-muted-foreground">Endpoint: <code>{endpointName}</code></span></label>
                    <div className="col-span-2 mt-1 border-t border-border/70 pt-5 max-sm:col-span-1"><h4 className="m-0 text-sm font-medium">Authentication</h4><p className="mb-0 mt-1 text-xs leading-5 text-muted-foreground">Stored keys are never shown here.</p></div>
                    <label className={`${labelClass} col-span-2 max-sm:col-span-1`}>API key<input className={fieldClass} type="password" autoComplete="new-password" value={apiKey} disabled={clearApiKey} placeholder={providerPersisted ? 'Leave empty to keep the stored key' : 'Optional'} onChange={(event) => { setApiKey(event.target.value); setClearApiKey(false); setSaved(false) }} /></label>
                    {providerPersisted && <div className="col-span-2 flex flex-wrap items-center gap-3 max-sm:col-span-1"><Button size="sm" variant={clearApiKey ? 'destructive' : 'outline'} onClick={() => { setClearApiKey((current) => !current); setApiKey(''); setSaved(false) }}>{clearApiKey ? 'Key will be cleared' : 'Clear stored key'}</Button>{clearApiKey && <span className="text-xs text-destructive">Save provider to apply.</span>}</div>}
                  </fieldset>
                </div>
                <div role="tabpanel" id={`${panelId}-prompt`} aria-labelledby={`${panelId}-prompt-tab`} hidden={providerTab !== 'prompt'}>
                  <fieldset disabled={busy} className="m-0 flex min-w-0 flex-col gap-6 border-0 p-0">
                    <label className={labelClass}>System text<span className="font-normal leading-5 text-muted-foreground">Shared system instructions for models using this provider.</span><textarea className={`${fieldClass} min-h-40 font-mono`} rows={8} aria-label="System text" value={providerDraft.system_text} onChange={(event) => updateProvider('system_text', event.target.value)} placeholder="Add instructions for the assistant…" /></label>
                    <label className={labelClass}>Context separator<span className="font-normal leading-5 text-muted-foreground">Separates the selected context from the user input.</span><textarea className={`${fieldClass} font-mono`} rows={4} aria-label="Context separator" value={providerDraft.context_separator} onChange={(event) => updateProvider('context_separator', event.target.value)} /></label>
                  </fieldset>
                </div>
              </>}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
