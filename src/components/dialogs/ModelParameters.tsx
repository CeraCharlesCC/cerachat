import { useId, useState } from 'react'
import type { ModelProfile, ProviderProtocol } from '../../types'

interface Parameter {
  label: string
  path: string[]
  initial: string | number | boolean
  choices?: string[]
  min?: number
  max?: number
  step?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readPath(object: Record<string, unknown>, path: string[]): unknown {
  let value: unknown = object
  for (const key of path) value = isObject(value) ? value[key] : undefined
  return value
}

function writePath(object: Record<string, unknown>, path: string[], value: unknown): void {
  const [key, ...rest] = path
  if (!rest.length) {
    if (value === undefined) delete object[key]
    else object[key] = value
    return
  }
  const existing = object[key]
  if (existing !== undefined && !isObject(existing)) throw new Error(`${key} must be an object; edit Raw JSON overrides first`)
  const child = { ...(existing as Record<string, unknown> | undefined) }
  writePath(child, rest, value)
  if (Object.keys(child).length) object[key] = child
  else delete object[key]
}

function ParameterInput({ parameter, value, disabled, onChange }: {
  parameter: Parameter
  value: unknown
  disabled: boolean
  onChange: (value: string | number | boolean) => void
}) {
  const id = useId()
  const [draft, setDraft] = useState<{ source: unknown; text: string } | null>(null)
  if (typeof parameter.initial === 'boolean') return (
    <select className="field" aria-label={parameter.label} disabled={disabled} value={String(value ?? parameter.initial)} onChange={(event) => onChange(event.target.value === 'true')}>
      <option value="false">False</option><option value="true">True</option>
    </select>
  )
  return <>
    <input className="field" aria-label={parameter.label} disabled={disabled} type={typeof parameter.initial === 'number' ? 'number' : 'text'}
      min={parameter.min} max={parameter.max} step={parameter.step ?? 'any'} list={parameter.choices ? id : undefined}
      value={draft && draft.source === value ? draft.text : String(value ?? parameter.initial)} onBlur={() => setDraft(null)} onChange={(event) => {
        const text = event.target.value
        if (typeof parameter.initial !== 'number') { onChange(text); return }
        // Keep incomplete numeric input editable (e.g. a minus sign or decimal).
        const next = Number(text)
        if (text !== '' && Number.isFinite(next)) {
          setDraft({ source: next, text })
          onChange(next)
        } else setDraft({ source: value, text })
      }} />
    {parameter.choices && <datalist id={id}>{parameter.choices.map((choice) => <option key={choice} value={choice} />)}</datalist>}
  </>
}

export function ModelParameters({ model, protocol, onChange }: {
  model: Pick<ModelProfile, 'temperature' | 'raw_json_overrides'>
  protocol: ProviderProtocol
  onChange: (value: Pick<ModelProfile, 'temperature' | 'raw_json_overrides'>) => void
}) {
  const [remembered, setRemembered] = useState<Record<string, unknown>>({})
  const [editError, setEditError] = useState<string | null>(null)
  let overrides: Record<string, unknown> = {}
  let parseError: string | null = null
  try {
    const parsed: unknown = JSON.parse(model.raw_json_overrides)
    if (!isObject(parsed)) throw new Error('Raw JSON overrides must be a JSON object')
    overrides = parsed
  } catch (reason) { parseError = reason instanceof Error ? reason.message : String(reason) }

  const responses = protocol === 'openai_responses'
  const parameters: Parameter[] = [
    { label: 'Top P', path: ['top_p'], initial: 1, min: 0, max: 1 },
    { label: 'Reasoning effort', path: responses ? ['reasoning', 'effort'] : ['reasoning_effort'], initial: 'medium', choices: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
    { label: 'Verbosity', path: responses ? ['text', 'verbosity'] : ['verbosity'], initial: 'medium', choices: ['low', 'medium', 'high'] },
    ...(responses ? [
      { label: 'Reasoning summary', path: ['reasoning', 'summary'], initial: 'auto', choices: ['auto', 'concise', 'detailed'] },
    ] : [
      { label: 'Frequency penalty', path: ['frequency_penalty'], initial: 0, min: -2, max: 2 },
      { label: 'Presence penalty', path: ['presence_penalty'], initial: 0, min: -2, max: 2 },
      { label: 'Seed', path: ['seed'], initial: 0, step: '1' },
    ]),
    { label: 'Service tier', path: ['service_tier'], initial: 'auto', choices: ['auto', 'default', 'flex', 'priority'] },
    { label: 'Store response', path: ['store'], initial: false },
  ]

  const update = (parameter: Parameter, value: unknown) => {
    try {
      const next = structuredClone(overrides)
      writePath(next, parameter.path, value)
      onChange({ ...model, raw_json_overrides: JSON.stringify(next, null, 2) })
      setEditError(null)
    } catch (reason) { setEditError(reason instanceof Error ? reason.message : String(reason)) }
  }

  return <section className="col-span-2 min-w-0 border-t border-border/70 pt-3 max-sm:col-span-1" aria-label="Model request parameters">
    <h4 className="m-0 text-xs font-semibold">Request parameters</h4>
    <p className="mb-3 mt-1 text-xs leading-5 text-muted-foreground">Off omits the parameter and uses the API default. Support and accepted values depend on the model. Suggestions allow custom values. Controls and raw JSON stay in sync.</p>
    <div className="grid min-w-0 grid-cols-2 gap-3 max-sm:grid-cols-1">
      <div className="min-w-0">
        <div className="mb-1 flex items-center justify-between gap-2"><span className="text-xs font-medium">Temperature</span>
          <button type="button" role="switch" aria-label="Enable Temperature" aria-checked={model.temperature !== null} className={`rounded px-2 py-0.5 text-xs ${model.temperature !== null ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`} onClick={() => {
            if (model.temperature !== null) setRemembered((values) => ({ ...values, temperature: model.temperature }))
            onChange({ ...model, temperature: model.temperature === null ? Number(remembered.temperature ?? 1) : null })
          }}>{model.temperature !== null ? 'On' : 'Off'}</button>
        </div>
        <ParameterInput parameter={{ label: 'Temperature', path: ['temperature'], initial: 1, min: 0, max: 2 }} value={model.temperature ?? remembered.temperature} disabled={model.temperature === null} onChange={(value) => onChange({ ...model, temperature: Number(value) })} />
        <code className="text-[10px] text-muted-foreground">temperature</code>
      </div>
      {parameters.map((parameter) => {
        const key = parameter.path.join('.')
        const value = readPath(overrides, parameter.path)
        const enabled = value !== undefined
        return <div className="min-w-0" key={key}>
          <div className="mb-1 flex items-center justify-between gap-2"><span className="text-xs font-medium">{parameter.label}</span>
            <button type="button" role="switch" aria-label={`Enable ${parameter.label}`} aria-checked={enabled} disabled={!!parseError} className={`rounded px-2 py-0.5 text-xs disabled:opacity-50 ${enabled ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`} onClick={() => {
              if (enabled) setRemembered((values) => ({ ...values, [key]: value }))
              update(parameter, enabled ? undefined : remembered[key] ?? parameter.initial)
            }}>{enabled ? 'On' : 'Off'}</button>
          </div>
          <ParameterInput parameter={parameter} value={value ?? remembered[key]} disabled={!enabled || !!parseError} onChange={(next) => update(parameter, next)} />
          <code className="text-[10px] text-muted-foreground">{key}</code>
        </div>
      })}
    </div>
    <label className="field-label mt-3">Raw JSON overrides<textarea className="field font-mono" rows={6} value={model.raw_json_overrides} onChange={(event) => { onChange({ ...model, raw_json_overrides: event.target.value }); setEditError(null) }} /><span className="font-normal leading-4 text-muted-foreground">Additional parameters for this model. Request structure, token limit and Temperature use their dedicated fields.</span></label>
    {(parseError || editError) && <p role="alert" className="text-xs text-destructive">{parseError || editError}</p>}
  </section>
}
