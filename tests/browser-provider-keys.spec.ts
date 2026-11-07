import { test, expect } from '@playwright/test'

const profile = {
  id: 'secret-test', name: 'Secret test', protocol: 'openai_chat_completions',
  base_url: 'https://secret.test/v1', api_key_storage: 'plain_portable',
  system_text: '', context_separator: '\n',
}

test('new API keys stay in session until explicitly saved on the device', async ({ page }) => {
  await page.goto('/')
  const first = await page.evaluate(async (profile) => {
    const backend = await import('/src/lib/backend.ts')
    await backend.saveProvider(profile, 'session-only-key')
    const saved = localStorage.getItem(backend.BROWSER_PROVIDER_STORAGE_KEY) ?? ''
    const session = sessionStorage.getItem(backend.BROWSER_SESSION_KEYS_STORAGE_KEY) ?? ''
    return { saved, session, remember: backend.browserProviderKeyPersistence(profile.id) }
  }, profile)
  expect(first.saved).not.toContain('session-only-key')
  expect(first.session).toContain('session-only-key')
  expect(first.remember).toBe(false)
  expect(JSON.parse(first.saved).version).toBe(3)
  await page.reload()
  const afterReload = await page.evaluate(async () => {
    const backend = await import('/src/lib/backend.ts')
    const state = await backend.bootstrap()
    return { providers: state.provider_catalog.providers.length, session: sessionStorage.getItem(backend.BROWSER_SESSION_KEYS_STORAGE_KEY) }
  })
  expect(afterReload.providers).toBe(1)
  expect(afterReload.session).toContain('session-only-key')

  const optedIn = await page.evaluate(async (profile) => {
    const backend = await import('/src/lib/backend.ts')
    await backend.saveProvider(profile, null, true)
    return { stored: localStorage.getItem(backend.BROWSER_PROVIDER_STORAGE_KEY), remember: backend.browserProviderKeyPersistence(profile.id) }
  }, profile)
  expect(optedIn.stored).toContain('session-only-key')
  expect(optedIn.remember).toBe(true)

  const optedOut = await page.evaluate(async (profile) => {
    const backend = await import('/src/lib/backend.ts')
    await backend.saveProvider(profile, null, false)
    return { stored: localStorage.getItem(backend.BROWSER_PROVIDER_STORAGE_KEY), session: sessionStorage.getItem(backend.BROWSER_SESSION_KEYS_STORAGE_KEY) }
  }, profile)
  expect(optedOut.stored).not.toContain('session-only-key')
  expect(optedOut.session).toContain('session-only-key')
})

test('legacy provider secrets are validated and not silently discarded during migration', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async (profile) => {
    const backend = await import('/src/lib/backend.ts')
    const legacy = JSON.stringify({ version: 2, settings: { providers: [profile], models: [], selected_model_id: null }, secrets: { api_keys: { [profile.id]: 'legacy-key' } } })
    localStorage.setItem(backend.BROWSER_PROVIDER_STORAGE_KEY, legacy)
    const state = await backend.bootstrap()
    const unchanged = localStorage.getItem(backend.BROWSER_PROVIDER_STORAGE_KEY) === legacy
    const remembered = backend.browserProviderKeyPersistence(profile.id)
    await backend.saveProvider({ ...profile, name: 'Renamed' }, null)
    const migrated = JSON.parse(localStorage.getItem(backend.BROWSER_PROVIDER_STORAGE_KEY) ?? '')
    return { state, unchanged, remembered, migrated }
  }, profile)
  expect(result.state.provider_catalog.providers[0].id).toBe(profile.id)
  expect(result.unchanged).toBe(true)
  expect(result.remembered).toBe(true)
  expect(result.migrated.version).toBe(3)
  expect(result.migrated.secrets.api_keys[profile.id]).toBe('legacy-key')
  expect(result.migrated.remembered_provider_ids).toEqual([profile.id])
})
