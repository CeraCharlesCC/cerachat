import type {
  ModelProfile,
  ProviderCatalog,
  ProviderConfig,
  ProviderProfile,
  ProviderProtocol,
  UniqueModelId,
} from '../types'

const protocols = new Set<ProviderProtocol>(['openai_chat_completions', 'openai_responses'])
const u32Max = 4_294_967_295

export interface ActiveModel {
  provider: ProviderProfile
  model: ModelProfile
  unique_model_id: UniqueModelId
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  if (value !== value.trim()) throw new Error(`${label} must not have leading or trailing whitespace`)
  if (value.includes('::')) throw new Error(`${label} must not contain "::"`)
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
}

function assertProviderId(value: unknown): asserts value is string {
  assertIdentifier(value, 'Provider ID')
  if (value.endsWith(':')) throw new Error('Provider ID must not end with ":" because it would overlap the "::" model separator')
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > u32Max) {
    throw new Error(`${label} must be an integer from 1 to ${u32Max}`)
  }
}

export function makeUniqueModelId(providerId: string, modelId: string): UniqueModelId {
  assertProviderId(providerId)
  assertIdentifier(modelId, 'Model ID')
  return `${providerId}::${modelId}`
}

export function parseUniqueModelId(value: string): { providerId: string; modelId: string } {
  const parts = value.split('::')
  if (parts.length !== 2) throw new Error(`Invalid model selection "${value}"`)
  const [providerId, modelId] = parts
  assertIdentifier(providerId, 'Selected provider ID')
  assertIdentifier(modelId, 'Selected model ID')
  return { providerId, modelId }
}

export function validateProvider(provider: unknown): asserts provider is ProviderProfile {
  if (!isRecord(provider) || !hasExactKeys(provider, [
    'id', 'name', 'protocol', 'base_url', 'api_key_storage', 'system_text', 'temperature', 'raw_json_overrides', 'context_separator',
  ])) throw new Error('Provider has an invalid shape')

  assertProviderId(provider.id)
  assertString(provider.name, `Provider ${provider.id} name`)
  if (!provider.name.trim()) throw new Error(`Provider ${provider.id} name must not be empty`)
  if (!protocols.has(provider.protocol as ProviderProtocol)) throw new Error(`Provider ${provider.id} has an unsupported protocol`)
  assertString(provider.base_url, `Provider ${provider.id} base URL`)
  if (!provider.base_url.trim()) throw new Error(`Provider ${provider.id} base URL must not be empty`)
  if (provider.api_key_storage !== 'plain_portable') throw new Error(`Provider ${provider.id} has an unsupported API key storage mode`)
  assertString(provider.system_text, `Provider ${provider.id} system text`)
  if (provider.temperature !== null && (typeof provider.temperature !== 'number' || !Number.isFinite(provider.temperature))) {
    throw new Error(`Provider ${provider.id} temperature must be a finite number or null`)
  }
  assertString(provider.raw_json_overrides, `Provider ${provider.id} raw JSON overrides`)
  let overrides: unknown
  try {
    overrides = JSON.parse(provider.raw_json_overrides)
  } catch {
    throw new Error(`Provider ${provider.id} raw JSON overrides must be valid JSON`)
  }
  if (!isRecord(overrides)) throw new Error(`Provider ${provider.id} raw JSON overrides must be a JSON object`)
  assertString(provider.context_separator, `Provider ${provider.id} context separator`)
}

export function validateModel(model: unknown): asserts model is ModelProfile {
  if (!isRecord(model) || !hasExactKeys(model, ['provider_id', 'model_id', 'name', 'context_window', 'max_output_tokens'])) {
    throw new Error('Model has an invalid shape')
  }
  assertIdentifier(model.provider_id, 'Model provider ID')
  assertIdentifier(model.model_id, `Model ID for provider ${model.provider_id}`)
  assertString(model.name, `Model ${model.provider_id}::${model.model_id} name`)
  assertPositiveInteger(model.context_window, `Model ${model.provider_id}::${model.model_id} context window`)
  assertPositiveInteger(model.max_output_tokens, `Model ${model.provider_id}::${model.model_id} max output tokens`)
}

export function validateProviderCatalog(catalog: unknown): asserts catalog is ProviderCatalog {
  if (!isRecord(catalog) || !hasExactKeys(catalog, ['providers', 'models', 'selected_model_id'])) {
    throw new Error('Provider catalog has an invalid shape')
  }
  if (!Array.isArray(catalog.providers) || !Array.isArray(catalog.models)) {
    throw new Error('Provider catalog providers and models must be arrays')
  }

  const providerIds = new Set<string>()
  for (const provider of catalog.providers) {
    validateProvider(provider)
    if (providerIds.has(provider.id)) throw new Error(`Duplicate provider ID "${provider.id}"`)
    providerIds.add(provider.id)
  }

  const modelIds = new Set<UniqueModelId>()
  for (const model of catalog.models) {
    validateModel(model)
    if (!providerIds.has(model.provider_id)) throw new Error(`Model ${model.provider_id}::${model.model_id} has no provider`)
    const uniqueId = makeUniqueModelId(model.provider_id, model.model_id)
    if (modelIds.has(uniqueId)) throw new Error(`Duplicate model ID "${uniqueId}"`)
    modelIds.add(uniqueId)
  }

  if (catalog.selected_model_id !== null) {
    if (typeof catalog.selected_model_id !== 'string') throw new Error('Selected model ID must be a string or null')
    parseUniqueModelId(catalog.selected_model_id)
    if (!modelIds.has(catalog.selected_model_id as UniqueModelId)) {
      throw new Error(`Selected model "${catalog.selected_model_id}" does not exist`)
    }
  }
}

export function getActiveModel(catalog: ProviderCatalog): ActiveModel | null {
  if (catalog.selected_model_id === null) return null
  const { providerId, modelId } = parseUniqueModelId(catalog.selected_model_id)
  const provider = catalog.providers.find((item) => item.id === providerId)
  if (!provider) throw new Error(`Selected provider "${providerId}" does not exist`)
  const model = catalog.models.find((item) => item.provider_id === providerId && item.model_id === modelId)
  if (!model) throw new Error(`Selected model "${catalog.selected_model_id}" does not exist`)
  return { provider, model, unique_model_id: catalog.selected_model_id }
}

export function resolveProviderConfig(catalog: ProviderCatalog, apiKey: string): ProviderConfig {
  const active = getActiveModel(catalog)
  if (!active) throw new Error('Select a model before previewing or sending a request')
  return {
    ...active.provider,
    api_key: apiKey,
    model: active.model.model_id,
    context_window: active.model.context_window,
    max_output_tokens: active.model.max_output_tokens,
  }
}
