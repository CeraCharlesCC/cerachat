import { Check, ChevronDown, Search, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ModelProfile, ProviderCatalog, ProviderProfile, UniqueModelId } from '../../types'

export interface ProviderModelSelectorProps {
  catalog: ProviderCatalog
  onSelect: (id: UniqueModelId) => Promise<void>
  disabled?: boolean
}

interface ModelGroup {
  provider: ProviderProfile
  models: ModelProfile[]
}

function modelUniqueId(providerId: string, modelId: string): UniqueModelId {
  return `${providerId}::${modelId}` as UniqueModelId
}

function displayName(name: string, fallback: string): string {
  const trimmed = name.trim()
  return trimmed || fallback
}

function searchValue(value: string): string {
  return value.toLocaleLowerCase()
}

function selectionErrorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message
  if (typeof reason === 'string' && reason) return reason
  return 'The model could not be selected.'
}

export function ProviderModelSelector({ catalog, onSelect, disabled = false }: ProviderModelSelectorProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef(new Map<string, HTMLButtonElement>())
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pendingId, setPendingId] = useState<UniqueModelId | null>(null)
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const selectorId = useId()
  const popoverId = `${selectorId}-model-popover`
  const titleId = `${popoverId}-title`
  const listboxId = `${popoverId}-options`

  const activeSelection = useMemo(() => {
    if (!catalog.selected_model_id) return null
    const model = catalog.models.find((candidate) => modelUniqueId(candidate.provider_id, candidate.model_id) === catalog.selected_model_id)
    if (!model) return null
    const provider = catalog.providers.find((candidate) => candidate.id === model.provider_id)
    return provider ? { model, provider } : null
  }, [catalog.models, catalog.providers, catalog.selected_model_id])

  const modelGroups = useMemo<ModelGroup[]>(() => {
    const term = searchValue(query.trim())
    return catalog.providers.flatMap((provider) => {
      const providerLabel = displayName(provider.name, provider.id)
      const providerMatches = !term || searchValue(providerLabel).includes(term) || searchValue(provider.id).includes(term)
      const models = catalog.models.filter((model) => {
        if (model.provider_id !== provider.id) return false
        if (providerMatches) return true
        const modelLabel = displayName(model.name, model.model_id)
        return searchValue(modelLabel).includes(term) || searchValue(model.model_id).includes(term)
      })
      return models.length ? [{ provider, models }] : []
    })
  }, [catalog.models, catalog.providers, query])

  const visibleIds = useMemo(
    () => modelGroups.flatMap((group) => group.models.map((model) => modelUniqueId(group.provider.id, model.model_id))),
    [modelGroups],
  )

  useEffect(() => {
    if (!open) return
    searchRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return

    const dismissFromOutside = (event: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node) && pendingId === null) {
        setOpen(false)
        setQuery('')
        setSelectionError(null)
      }
    }
    const dismissWithEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || pendingId !== null) return
      event.preventDefault()
      setOpen(false)
      setQuery('')
      setSelectionError(null)
      triggerRef.current?.focus()
    }

    document.addEventListener('mousedown', dismissFromOutside)
    document.addEventListener('touchstart', dismissFromOutside)
    document.addEventListener('keydown', dismissWithEscape)
    return () => {
      document.removeEventListener('mousedown', dismissFromOutside)
      document.removeEventListener('touchstart', dismissFromOutside)
      document.removeEventListener('keydown', dismissWithEscape)
    }
  }, [open, pendingId])

  const closeSelector = () => {
    if (pendingId !== null) return
    setOpen(false)
    setQuery('')
    setSelectionError(null)
  }

  const openSelector = () => {
    if (disabled || pendingId !== null) return
    setSelectionError(null)
    setQuery('')
    setOpen(true)
  }

  const selectModel = async (id: UniqueModelId) => {
    if (disabled || pendingId !== null) return
    setSelectionError(null)
    setPendingId(id)
    try {
      await onSelect(id)
      setPendingId(null)
      setOpen(false)
      setQuery('')
      triggerRef.current?.focus()
    } catch (reason) {
      setSelectionError(selectionErrorMessage(reason))
      setPendingId(null)
    }
  }

  const focusOption = (id: string) => {
    optionRefs.current.get(id)?.focus()
  }

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowDown' || !visibleIds.length) return
    event.preventDefault()
    focusOption(visibleIds[0])
  }

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: UniqueModelId) => {
    const currentIndex = visibleIds.indexOf(id)
    if (currentIndex < 0) return

    let nextIndex: number | null = null
    if (event.key === 'ArrowDown') nextIndex = Math.min(currentIndex + 1, visibleIds.length - 1)
    if (event.key === 'ArrowUp') nextIndex = Math.max(currentIndex - 1, 0)
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = visibleIds.length - 1
    if (nextIndex === null) return

    event.preventDefault()
    focusOption(visibleIds[nextIndex])
  }

  const activeProviderName = activeSelection ? displayName(activeSelection.provider.name, activeSelection.provider.id) : null
  const activeModelName = activeSelection ? displayName(activeSelection.model.name, activeSelection.model.model_id) : null
  const selectedModelIsUnavailable = catalog.selected_model_id !== null && activeSelection === null

  return (
    <div ref={rootRef} className="relative min-w-0 max-w-[min(20rem,46vw)]">
      <button
        ref={triggerRef}
        type="button"
        className="flex min-w-0 max-w-full items-center gap-2 rounded-xl border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border/70 hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-45"
        aria-label={activeSelection ? `Select model, current model ${activeModelName} from ${activeProviderName}` : 'Select a model'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popoverId}
        disabled={disabled || pendingId !== null}
        onClick={() => (open ? closeSelector() : openSelector())}
        title={activeSelection ? `${activeProviderName} · ${activeModelName}` : 'Select a model'}
      >
        <span className="min-w-0 flex-1">
          {activeSelection ? (
            <>
              <span className="block truncate text-[11px] font-medium text-muted-foreground">{activeProviderName}</span>
              <strong className="block truncate text-sm font-semibold">{activeModelName}</strong>
            </>
          ) : (
            <span className="block truncate text-sm font-semibold">Select a model</span>
          )}
        </span>
        <ChevronDown size={15} aria-hidden="true" className={`shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          id={popoverId}
          role="dialog"
          aria-labelledby={titleId}
          className="absolute left-0 top-full z-40 mt-2 flex w-[min(25rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-border/70 bg-popover text-popover-foreground shadow-[var(--shadow)] max-[640px]:fixed max-[640px]:inset-x-2 max-[640px]:top-16 max-[640px]:mt-2 max-[640px]:w-auto max-[640px]:max-w-none"
        >
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
            <h2 id={titleId} className="sr-only">Select a model</h2>
            <Search size={15} aria-hidden="true" className="shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search providers or models…"
              aria-label="Search providers and models"
              aria-controls={listboxId}
            />
            <button
              type="button"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              aria-label="Close model selector"
              onClick={closeSelector}
              disabled={pendingId !== null}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>

          {selectedModelIsUnavailable && (
            <p className="mx-3 mt-3 rounded-lg border border-destructive/25 bg-destructive/10 px-2.5 py-2 text-xs text-destructive" role="alert">
              The saved model is unavailable. Choose a model to continue.
            </p>
          )}
          {selectionError && (
            <p className="mx-3 mt-3 rounded-lg border border-destructive/25 bg-destructive/10 px-2.5 py-2 text-xs text-destructive" role="alert">
              Could not select model: {selectionError}
            </p>
          )}

          <div id={listboxId} role="listbox" aria-label="Available models" aria-busy={pendingId !== null} className="scroll-stable max-h-[min(65dvh,28rem)] overflow-y-auto p-2">
            {modelGroups.length ? modelGroups.map((group, groupIndex) => {
              const providerLabel = displayName(group.provider.name, group.provider.id)
              const headingId = `${popoverId}-provider-${groupIndex}`
              return (
                <section key={group.provider.id} role="group" aria-labelledby={headingId} className={groupIndex ? 'mt-2' : ''}>
                  <h3 id={headingId} className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{providerLabel}</h3>
                  <div className="space-y-0.5">
                    {group.models.map((model) => {
                      const id = modelUniqueId(group.provider.id, model.model_id)
                      const modelLabel = displayName(model.name, model.model_id)
                      const hasSeparateRawId = modelLabel !== model.model_id
                      return (
                        <button
                          key={id}
                          ref={(element) => {
                            if (element) optionRefs.current.set(id, element)
                            else optionRefs.current.delete(id)
                          }}
                          type="button"
                          role="option"
                          aria-selected={catalog.selected_model_id === id}
                          aria-label={`${modelLabel} (${model.model_id})`}
                          className="flex min-h-11 w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-selected:bg-accent/80 disabled:pointer-events-none disabled:opacity-55"
                          disabled={pendingId !== null}
                          onKeyDown={(event) => handleOptionKeyDown(event, id)}
                          onClick={() => void selectModel(id)}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{modelLabel}</span>
                            {hasSeparateRawId && <span className="block truncate font-mono text-[11px] text-muted-foreground">{model.model_id}</span>}
                          </span>
                          {pendingId === id ? (
                            <span className="shrink-0 text-xs text-muted-foreground" aria-label="Selecting">…</span>
                          ) : catalog.selected_model_id === id ? (
                            <Check size={16} aria-hidden="true" className="shrink-0 text-primary" />
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                </section>
              )
            }) : (
              <p className="px-2.5 py-5 text-center text-sm text-muted-foreground">
                {catalog.models.length ? 'No models match your search.' : 'No models configured.'}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
