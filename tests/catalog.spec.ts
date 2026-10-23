import { expect, test, type Page } from '@playwright/test'

const storageKey = 'cerachat.provider-catalog.v1'

async function seedCatalog(page: Page) {
  await page.evaluate(async () => {
    const backend = await import('/src/lib/backend.ts')
    const provider = {
      id: 'alpha', name: 'Alpha Gateway', protocol: 'openai_chat_completions',
      base_url: 'https://alpha.invalid/v1', api_key_storage: 'plain_portable',
      system_text: 'Alpha system', context_separator: '\n\n',
    }
    await backend.saveProvider(provider, 'alpha-secret')
    await backend.saveProvider({ ...provider, id: 'beta', name: 'Beta Local', protocol: 'openai_responses', base_url: 'http://127.0.0.1:11434/v1' }, 'beta-secret')
    await backend.saveModel({ provider_id: 'alpha', model_id: 'shared-api', name: 'Friendly Alpha', context_window: 128000, max_output_tokens: 4096, temperature: 0.4, raw_json_overrides: '{}' })
    await backend.saveModel({ provider_id: 'alpha', model_id: 'tiny-api', name: 'Tiny', context_window: 32000, max_output_tokens: 1024, temperature: null, raw_json_overrides: '{}' })
    await backend.saveModel({ provider_id: 'beta', model_id: 'shared-api', name: 'Friendly Beta', context_window: 64000, max_output_tokens: 2048, temperature: null, raw_json_overrides: '{}' })
    await backend.selectModel('alpha::shared-api')
  })
  await page.reload()
}

test('fresh catalog disables requests and bootstrap/editor/selector make no provider calls', async ({ page }) => {
  const externalRequests: string[] = []
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4173/')) externalRequests.push(request.url())
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Regenerate response' }).first()).toBeDisabled()
  await page.getByRole('button', { name: 'Select a model' }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('main').getByRole('button', { name: 'Provider settings', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Provider settings' })).toBeVisible()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  expect(externalRequests).toEqual([])
})

test('grouped search and selection persist, resolve model limits and clear on deletion without network', async ({ page }) => {
  await page.goto('/')
  await seedCatalog(page)
  await page.waitForLoadState('networkidle')
  const requests: string[] = []
  page.on('request', (request) => requests.push(request.url()))
  // All application modules are loaded before measuring local UI mutations.
  const selector = page.getByRole('button', { name: /Friendly Alpha/ }).first()
  await selector.click()
  const options = page.getByRole('listbox', { name: 'Available models' })
  await expect(options.getByRole('option', { selected: true })).toContainText('Friendly Alpha')
  await expect(page.getByRole('heading', { name: 'Alpha Gateway' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Beta Local' })).toBeVisible()
  const search = page.getByRole('searchbox')
  await search.fill('Beta Local')
  await expect(options.getByRole('option', { name: /Friendly Beta/ })).toBeVisible()
  await expect(options.getByRole('option', { name: /Friendly Alpha/ })).toHaveCount(0)
  await search.fill('Friendly Alpha')
  await expect(options.getByRole('option', { name: /Friendly Alpha/ })).toBeVisible()
  await search.fill('tiny-api')
  await expect(options.getByRole('option', { name: /Tiny/ })).toBeVisible()
  await search.fill('shared-api')
  await options.getByRole('option', { name: /Friendly Beta/ }).click()
  await expect(page.getByRole('button', { name: /Friendly Beta/ }).first()).toBeVisible()
  expect(requests).toEqual([])
  await page.reload()
  await expect(page.getByRole('button', { name: /Friendly Beta/ }).first()).toBeVisible()
  const resolved = await page.evaluate(async () => {
    const backend = await import('/src/lib/backend.ts')
    const state = await backend.bootstrap()
    const preview = await backend.compileRequest({ conversationId: state.conversations[0].id, parentId: null, input: 'hello', historyMode: 'no_history' })
    return { catalog: state.provider_catalog, json: JSON.parse(preview.request_json), breakdown: preview.breakdown }
  })
  expect(resolved.catalog.selected_model_id).toBe('beta::shared-api')
  expect(resolved.json.model).toBe('shared-api')
  expect(resolved.json.max_output_tokens).toBe(2048)
  expect(resolved.breakdown.configured_context).toBe(64000)
  const afterDelete = await page.evaluate(async () => {
    const backend = await import('/src/lib/backend.ts')
    return backend.deleteModel('beta', 'shared-api')
  })
  expect(afterDelete.selected_model_id).toBeNull()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Select a model' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toBeDisabled()
})

test('local mutation failures preserve valid data, secret separation and provider cascade', async ({ page }) => {
  const externalRequests: string[] = []
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4173/')) externalRequests.push(request.url())
  })
  await page.goto('/')
  await seedCatalog(page)
  const result = await page.evaluate(async (key) => {
    const backend = await import('/src/lib/backend.ts')
    const before = localStorage.getItem(key)
    const errors: string[] = []
    for (const id of ['missing::shared-api', 'alpha::missing']) {
      try { await backend.selectModel(id) } catch (reason) { errors.push(String(reason)) }
    }
    const invalidPreserved = before === localStorage.getItem(key)
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = () => { throw new DOMException('Full', 'QuotaExceededError') }
    try { await backend.selectModel('beta::shared-api') } catch (reason) { errors.push(String(reason)) }
    finally { Storage.prototype.setItem = setItem }
    const failedWritePreserved = before === localStorage.getItem(key)
    const afterFailure = (await backend.bootstrap()).provider_catalog.selected_model_id
    await backend.deleteModel('alpha', 'tiny-api')
    const afterInactiveDelete = (await backend.bootstrap()).provider_catalog.selected_model_id
    const catalog = await backend.deleteProvider('alpha')
    return { errors, invalidPreserved, failedWritePreserved, afterFailure, afterInactiveDelete, catalog, persisted: JSON.parse(localStorage.getItem(key)!) }
  }, storageKey)
  expect(result.errors).toHaveLength(3)
  expect(result.invalidPreserved).toBe(true)
  expect(result.failedWritePreserved).toBe(true)
  expect(result.afterFailure).toBe('alpha::shared-api')
  expect(result.afterInactiveDelete).toBe('alpha::shared-api')
  expect(result.catalog.selected_model_id).toBeNull()
  expect(result.catalog.models.every((model: {provider_id: string}) => model.provider_id !== 'alpha')).toBe(true)
  expect(result.persisted.secrets.api_keys).toEqual({ beta: 'beta-secret' })
  expect(JSON.stringify(result.persisted.settings)).not.toContain('beta-secret')
  expect(JSON.stringify(result.persisted.settings)).not.toContain('api_key"')
  expect(externalRequests).toEqual([])
})

test('incompatible browser settings fail visibly and are never rewritten', async ({ page }) => {
  await page.goto('/')
  const malformed = JSON.stringify({ version: 987, provider: { model: 'old-format' } })
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: storageKey, value: malformed })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Could not open local workspace' })).toBeVisible()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(0)
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe(malformed)
})

test('strict browser schema rejects inconsistent records without changing storage or sending', async ({ page }) => {
  await page.goto('/')
  await seedCatalog(page)
  const failures = await page.evaluate(async (key) => {
    const backend = await import('/src/lib/backend.ts')
    const valid = localStorage.getItem(key)!
    const mutations = [
      (data: Record<string, unknown>) => { delete data.version },
      (data: Record<string, unknown>) => { data.version = '1' },
      (data: Record<string, unknown>) => { data.version = 987 },
      (data: Record<string, unknown>) => { data.unexpected = true },
    ]
    const invalid = mutations.map((mutate) => { const data = JSON.parse(valid); mutate(data); return JSON.stringify(data) })
    const cases = [
      'duplicate-provider', 'duplicate-model', 'orphan-model', 'bad-selection',
      'unknown-secret', 'missing-secret', 'missing-selection', 'missing-temperature',
      'string-limit', 'zero-limit', 'fraction-limit', 'secret-in-settings', 'overlapping-provider-separator',
    ]
    for (const scenario of cases) {
      const data = JSON.parse(valid)
      switch (scenario) {
        case 'duplicate-provider': data.settings.providers.push(data.settings.providers[0]); break
        case 'duplicate-model': data.settings.models.push(data.settings.models[0]); break
        case 'orphan-model': data.settings.models[0].provider_id = 'orphan'; break
        case 'bad-selection': data.settings.selected_model_id = 'alpha::nonexistent'; break
        case 'unknown-secret': data.secrets.api_keys.orphan = 'secret'; break
        case 'missing-secret': delete data.secrets.api_keys.alpha; break
        case 'missing-selection': delete data.settings.selected_model_id; break
        case 'missing-temperature': delete data.settings.models[0].temperature; break
        case 'string-limit': data.settings.models[0].context_window = '64000'; break
        case 'zero-limit': data.settings.models[0].context_window = 0; break
        case 'fraction-limit': data.settings.models[0].context_window = 1.5; break
        case 'secret-in-settings': data.settings.providers[0].api_key = 'leaked'; break
        case 'overlapping-provider-separator': {
          data.settings.providers[0].id = 'alpha:'
          for (const model of data.settings.models) if (model.provider_id === 'alpha') model.provider_id = 'alpha:'
          data.settings.selected_model_id = null
          data.secrets.api_keys['alpha:'] = data.secrets.api_keys.alpha
          delete data.secrets.api_keys.alpha
          break
        }
      }
      invalid.push(JSON.stringify(data))
    }
    invalid.push('{broken json')
    const failed: string[] = []
    for (const [index, encoded] of invalid.entries()) {
      localStorage.setItem(key, encoded)
      let rejected = false
      try { await backend.bootstrap() } catch { rejected = true }
      if (!rejected || localStorage.getItem(key) !== encoded) failed.push(`case ${index}`)
    }
    localStorage.setItem(key, valid)
    await backend.deleteModel('alpha', 'shared-api')
    const beforeMessages = await backend.getMessages('demo-chat')
    for (const action of [
      () => backend.compileRequest({ conversationId: 'demo-chat', parentId: null, input: 'blocked', historyMode: 'no_history' }),
      () => backend.sendMessage({ conversationId: 'demo-chat', parentId: null, input: 'blocked', historyMode: 'no_history' }),
      () => backend.regenerateResponse({ conversationId: 'demo-chat', userMessageId: 'u1', historyMode: 'no_history' }),
    ]) {
      let rejected = false
      try { await action() } catch { rejected = true }
      if (!rejected) failed.push('unselected request did not fail')
    }
    if (JSON.stringify(beforeMessages) !== JSON.stringify(await backend.getMessages('demo-chat'))) failed.push('failed send changed messages')
    return failed
  }, storageKey)
  expect(failures).toEqual([])
})

test('selector keeps failed selections visible and leaves the active model unchanged', async ({ page }) => {
  await page.goto('/')
  await seedCatalog(page)
  await page.getByRole('button', { name: /Friendly Alpha/ }).first().click()
  await page.evaluate(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Storage is full', 'QuotaExceededError') }
  })
  await page.getByRole('option', { name: /Friendly Beta/ }).click()
  const selector = page.getByRole('dialog', { name: 'Select a model' })
  await expect(selector).toBeVisible()
  await expect(selector.getByRole('alert')).toContainText('Could not select model')
  await expect(selector.getByRole('option', { selected: true })).toContainText('Friendly Alpha')
  await page.keyboard.press('Escape')
  await expect(selector).not.toBeVisible()
  await expect(page.getByRole('button', { name: /Friendly Alpha/ }).first()).toBeFocused()
})

test('compact selector stays inside the viewport and supports keyboard selection', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await seedCatalog(page)
  await page.getByRole('button', { name: /Friendly Alpha/ }).first().click()
  const selector = page.getByRole('dialog', { name: 'Select a model' })
  const bounds = await selector.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  await expect(page.getByRole('searchbox')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(selector).not.toBeVisible()
  await expect(page.getByRole('button', { name: /Friendly Beta/ }).first()).toBeVisible()
})

test('catalog editor creates, edits and deletes locally with explicit key updates', async ({ page }) => {
  const externalRequests: string[] = []
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4173/')) externalRequests.push(request.url())
  })
  page.on('dialog', (dialog) => void dialog.accept())
  await page.goto('/')
  const settingsButton = page.getByRole('main').getByRole('button', { name: 'Provider settings', exact: true })
  await settingsButton.click()
  const editor = page.getByRole('dialog', { name: 'Provider settings' })
  await editor.getByRole('button', { name: 'Add provider', exact: true }).last().click()
  await editor.getByLabel('Provider ID', { exact: true }).fill('manual')
  await editor.getByLabel('Provider name', { exact: true }).fill('Manual Gateway')
  await editor.getByLabel(/^Base URL/).fill('https://manual.invalid/v1')
  await editor.locator('input[type=password]').fill('manual-secret')
  await editor.getByRole('button', { name: 'Save provider', exact: true }).click()
  await expect(editor.getByLabel('Provider ID', { exact: true })).toHaveAttribute('readonly')
  await editor.getByRole('button', { name: 'Add model', exact: true }).click()
  await editor.getByLabel('Model ID', { exact: true }).fill('raw-manual-model')
  await editor.getByLabel('Context window', { exact: true }).fill('128000')
  await editor.getByLabel('Max output tokens', { exact: true }).fill('1024')
  await editor.getByRole('button', { name: 'Save model', exact: true }).click()
  await expect(editor.getByLabel('Model ID', { exact: true })).toHaveAttribute('readonly')
  await editor.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'Select a model' }).click()
  await page.getByRole('option', { name: /raw-manual-model/ }).click()
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()

  await settingsButton.click()
  await editor.getByLabel('Provider name', { exact: true }).fill('Renamed Gateway')
  await editor.getByRole('button', { name: 'Save provider', exact: true }).click()
  let saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), storageKey)
  expect(saved.secrets.api_keys.manual).toBe('manual-secret')
  await editor.getByRole('button', { name: 'Clear stored key', exact: true }).click()
  await editor.getByRole('button', { name: 'Save provider', exact: true }).click()
  saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), storageKey)
  expect(saved.secrets.api_keys.manual).toBe('')
  await editor.getByRole('button', { name: /raw-manual-model/ }).click()
  await editor.getByLabel('Display name (optional)', { exact: true }).fill('Renamed Model')
  await editor.getByLabel('Max output tokens', { exact: true }).fill('2048')
  await editor.getByRole('button', { name: 'Save model', exact: true }).click()
  await editor.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByRole('button', { name: /Renamed Model from Renamed Gateway/ })).toBeVisible()
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  const preview = page.getByRole('dialog', { name: 'Request preview' })
  await expect(preview.locator('pre').first()).toContainText('"max_completion_tokens": 2048')
  await preview.getByRole('button', { name: 'Close', exact: true }).click()

  await settingsButton.click()
  await editor.getByRole('button', { name: /Renamed Model/ }).click()
  await editor.getByRole('button', { name: 'Delete model', exact: true }).click()
  await expect(editor.getByText('No models saved.', { exact: true })).toBeVisible()
  await editor.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(editor.getByText('No providers configured.', { exact: true })).toBeVisible()
  await editor.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Select a model' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  expect(externalRequests).toEqual([])
})

test('adding an existing ID reports a local error without overwriting saved records', async ({ page }) => {
  await page.goto('/')
  await seedCatalog(page)
  const before = await page.evaluate((key) => localStorage.getItem(key), storageKey)
  await page.getByRole('main').getByRole('button', { name: 'Provider settings', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Provider settings' })
  await editor.getByRole('button', { name: 'Add provider', exact: true }).last().click()
  await editor.getByLabel('Provider ID', { exact: true }).fill('alpha')
  await editor.getByRole('button', { name: 'Save provider', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('already exists')
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe(before)
  await editor.getByRole('button', { name: /Alpha Gateway/ }).click()
  await editor.getByRole('button', { name: 'Add model', exact: true }).click()
  await editor.getByLabel('Model ID', { exact: true }).fill('shared-api')
  await editor.getByRole('button', { name: 'Save model', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('already exists')
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe(before)
})

for (const action of ['Preview', 'Send message', 'Regenerate response']) {
  test(`${action} refreshes a selection removed by another instance and stays local`, async ({ page }) => {
    await page.goto('/')
    await seedCatalog(page)
    const before = await page.evaluate(async () => {
      const backend = await import('/src/lib/backend.ts')
      await backend.deleteModel('alpha', 'shared-api')
      return backend.getMessages('demo-chat')
    })
    await page.getByRole('button', { name: action, exact: true }).first().click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Select a model' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Preview', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Regenerate response' }).first()).toBeDisabled()
    const after = await page.evaluate(async () => {
      const backend = await import('/src/lib/backend.ts')
      return backend.getMessages('demo-chat')
    })
    expect(after).toEqual(before)
  })
}

test('model parameters are independent, toggled, synchronized with raw JSON and encoded for each API', async ({ page }) => {
  await page.goto('/')
  await seedCatalog(page)
  await page.getByRole('main').getByRole('button', { name: 'Provider settings', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Provider settings' })
  await expect(editor.getByLabel('Temperature', { exact: true })).toHaveCount(0)
  await editor.getByRole('button', { name: /Friendly Alpha/ }).click()
  await expect(editor.getByRole('switch', { name: 'Enable Temperature', exact: true })).toBeChecked()
  await editor.getByLabel('Temperature', { exact: true }).fill('0')
  await editor.getByRole('switch', { name: 'Enable Reasoning effort', exact: true }).click()
  await editor.getByLabel('Reasoning effort', { exact: true }).fill('high')
  await editor.getByRole('switch', { name: 'Enable Verbosity', exact: true }).click()
  await editor.getByLabel('Verbosity', { exact: true }).fill('low')
  await editor.getByRole('switch', { name: 'Enable Frequency penalty', exact: true }).click()
  await editor.getByLabel('Frequency penalty', { exact: true }).fill('')
  await editor.getByLabel('Frequency penalty', { exact: true }).pressSequentially('-0.5')
  await expect(editor.getByLabel('Reasoning summary', { exact: true })).toHaveCount(0)
  await editor.getByRole('switch', { name: 'Enable Store response', exact: true }).click()
  expect(JSON.parse(await editor.getByLabel('Raw JSON overrides').inputValue())).toEqual({ reasoning_effort: 'high', verbosity: 'low', frequency_penalty: -0.5, store: false })
  await editor.getByRole('button', { name: 'Save model', exact: true }).click()
  await editor.getByRole('button', { name: /Tiny/ }).click()
  await expect(editor.getByRole('switch', { name: 'Enable Temperature', exact: true })).not.toBeChecked()
  await expect(editor.getByLabel('Temperature', { exact: true })).toBeDisabled()
  await expect(editor.getByRole('switch', { name: 'Enable Reasoning effort', exact: true })).not.toBeChecked()
  await expect(editor.getByLabel('Raw JSON overrides')).toHaveValue('{}')
  await editor.getByRole('button', { name: 'Beta Local beta', exact: true }).click()
  await editor.getByRole('button', { name: /Friendly Beta/ }).click()
  await expect(editor.getByLabel('Frequency penalty', { exact: true })).toHaveCount(0)
  await editor.getByLabel('Raw JSON overrides').fill('{"reasoning":{"effort":"xhigh","summary":"auto","custom":true},"text":{"verbosity":"high","format":{"type":"text"}},"store":false,"custom":42}')
  await expect(editor.getByLabel('Reasoning effort', { exact: true })).toHaveValue('xhigh')
  await editor.getByRole('switch', { name: 'Enable Reasoning summary', exact: true }).click()
  await editor.getByRole('switch', { name: 'Enable Reasoning effort', exact: true }).click()
  expect(JSON.parse(await editor.getByLabel('Raw JSON overrides').inputValue()).reasoning).toEqual({ custom: true })
  await editor.getByRole('switch', { name: 'Enable Reasoning effort', exact: true }).click()
  await expect(editor.getByLabel('Reasoning effort', { exact: true })).toHaveValue('xhigh')
  await editor.getByRole('switch', { name: 'Enable Top P', exact: true }).click()
  await editor.getByLabel('Top P', { exact: true }).fill('0.75')
  await editor.getByRole('button', { name: 'Save model', exact: true }).click()
  await editor.getByRole('button', { name: 'Done', exact: true }).click()
  await page.reload()
  const bodies = await page.evaluate(async () => {
    const backend = await import('/src/lib/backend.ts')
    const args = { conversationId: 'demo-chat', parentId: null, input: 'Question', historyMode: 'no_history' }
    await backend.selectModel('alpha::shared-api')
    const chat = JSON.parse((await backend.compileRequest(args)).request_json)
    await backend.selectModel('beta::shared-api')
    const responses = JSON.parse((await backend.compileRequest(args)).request_json)
    await backend.selectModel('alpha::tiny-api')
    const tiny = JSON.parse((await backend.compileRequest(args)).request_json)
    return { chat, responses, tiny }
  })
  expect(bodies.chat).toMatchObject({ temperature: 0, reasoning_effort: 'high', verbosity: 'low', frequency_penalty: -0.5, store: false, max_completion_tokens: 4096 })
  expect(bodies.chat).not.toHaveProperty('reasoning')
  expect(bodies.chat).not.toHaveProperty('max_tokens')
  expect(bodies.responses).toMatchObject({ reasoning: { effort: 'xhigh', custom: true }, text: { verbosity: 'high', format: { type: 'text' } }, store: false, custom: 42, top_p: 0.75, max_output_tokens: 2048 })
  expect(bodies.responses).not.toHaveProperty('reasoning.summary')
  expect(bodies.responses).not.toHaveProperty('temperature')
  expect(bodies.tiny).not.toHaveProperty('temperature')
  expect(bodies.tiny).not.toHaveProperty('reasoning_effort')
})

test('version 1 parameters migrate to every existing model and persist only on an explicit save', async ({ page }) => {
  await page.goto('/')
  const legacy = JSON.stringify({ version: 1, settings: {
    providers: [{ id: 'old', name: 'Old', protocol: 'openai_responses', base_url: 'https://unused.invalid/v1', api_key_storage: 'plain_portable', system_text: '', context_separator: '\n', temperature: 0.3, raw_json_overrides: '{"reasoning":{"effort":"high"},"store":false}' }],
    models: ['one', 'two'].map((model_id) => ({ provider_id: 'old', model_id, name: '', context_window: 4096, max_output_tokens: 512 })),
    selected_model_id: 'old::one',
  }, secrets: { api_keys: { old: 'preserved' } } })
  const result = await page.evaluate(async ({ key, legacy }) => {
    localStorage.setItem(key, legacy)
    const backend = await import('/src/lib/backend.ts')
    const catalog = (await backend.bootstrap()).provider_catalog
    const unchanged = localStorage.getItem(key) === legacy
    await backend.saveModel({ ...catalog.models[0], temperature: null, raw_json_overrides: '{}' })
    await backend.selectModel('old::two')
    const body = JSON.parse((await backend.compileRequest({ conversationId: 'demo-chat', parentId: null, input: 'Question', historyMode: 'no_history' })).request_json)
    return { catalog, unchanged, saved: JSON.parse(localStorage.getItem(key)!), body }
  }, { key: storageKey, legacy })
  expect(result.unchanged).toBe(true)
  for (const model of result.catalog.models) expect(model).toMatchObject({ temperature: 0.3, raw_json_overrides: '{"reasoning":{"effort":"high"},"store":false}' })
  expect(result.catalog.providers[0]).not.toHaveProperty('temperature')
  expect(result.catalog.providers[0]).not.toHaveProperty('raw_json_overrides')
  expect(result.saved.version).toBe(2)
  expect(result.saved.secrets.api_keys).toEqual({ old: 'preserved' })
  expect(result.saved.settings.models[0].temperature).toBeNull()
  expect(result.body).toMatchObject({ temperature: 0.3, reasoning: { effort: 'high' }, store: false })
})
