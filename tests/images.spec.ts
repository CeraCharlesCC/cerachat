import { expect, test, type Page } from '@playwright/test'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
const dataUrl = `data:image/png;base64,${png}`
const image = { name: 'sample.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }

async function open(page: Page, service = 'openrouter', protocol = 'openai_chat_completions', enabled = true) {
  await page.addInitScript(({ service, protocol, enabled }) => {
    if (localStorage.getItem('cerachat.provider-catalog.v1')) return
    localStorage.setItem('cerachat.provider-catalog.v1', JSON.stringify({
      version: 2,
      settings: {
        providers: [{ id: service, name: service, protocol, base_url: `https://${service}.invalid/v1`, api_key_storage: 'plain_portable', system_text: '', context_separator: '\n---\n' }],
        models: [true, false].map((vision) => ({ provider_id: service, model_id: vision ? 'arbitrary-model' : 'text-model', name: vision ? 'Vision' : 'Text only', context_window: 128000, max_output_tokens: 1024, temperature: null, raw_json_overrides: '{}', image_input: vision && enabled })),
        selected_model_id: `${service}::arbitrary-model`,
      }, secrets: { api_keys: { [service]: '' } },
    }))
  }, { service, protocol, enabled })
  await page.goto('/')
  await expect(page.getByLabel('Message input')).toBeVisible()
  await page.getByRole('combobox', { name: 'History', exact: true }).selectOption('no_history')
  const remove = page.getByRole('button', { name: 'Remove context slice', exact: true })
  while (await remove.count()) { const count = await remove.count(); await remove.first().click(); await expect(remove).toHaveCount(count - 1) }
}

async function preview(page: Page) {
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Request preview' })
  const json = JSON.parse((await dialog.locator('pre').first().textContent())!)
  await expect(dialog).toContainText('token estimates cover text only', { ignoreCase: true })
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  return json
}

for (const service of ['openrouter', 'nvidia-nim', 'nanogpt']) {
  test(`${service}: image-only and mixed requests preserve bytes for arbitrary model IDs`, async ({ page }) => {
    await open(page, service)
    const external: string[] = []
    page.on('request', (request) => { if (!request.url().startsWith('http://127.0.0.1:4173/')) external.push(request.url()) })
    await page.getByLabel('Choose images').setInputFiles(image)
    await expect(page.getByRole('button', { name: 'View image sample.png' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
    const only = await preview(page)
    expect(only.messages.at(-1).content).toEqual([{ type: 'image_url', image_url: { url: dataUrl } }])
    await page.getByLabel('Message input').fill('Describe 日本語')
    const mixed = await preview(page)
    expect(mixed.messages.at(-1).content).toEqual([{ type: 'text', text: 'Describe 日本語' }, { type: 'image_url', image_url: { url: dataUrl } }])
    await page.getByRole('button', { name: 'View image sample.png' }).click()
    await expect(page.getByRole('dialog', { name: 'sample.png' }).getByRole('img')).toHaveAttribute('src', dataUrl)
    await page.getByRole('dialog', { name: 'sample.png' }).getByRole('button', { name: 'Close' }).click()
    expect(external).toEqual([])
  })
}

test('Responses uses its image schema and saved images survive editing, regeneration and chat switches', async ({ page }) => {
  await open(page, 'nanogpt', 'openai_responses')
  await page.getByLabel('Choose images').setInputFiles(image)
  await page.getByLabel('Message input').fill('Original')
  expect((await preview(page)).input.at(-1).content).toEqual([{ type: 'input_text', text: 'Original' }, { type: 'input_image', image_url: dataUrl }])
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  const user = page.getByRole('article', { name: 'User message' }).last()
  await expect(user.getByRole('img')).toHaveAttribute('src', dataUrl)
  await user.getByRole('button', { name: 'Edit message', exact: true }).click()
  await page.getByLabel('Edited message').fill('Edited')
  await page.getByRole('button', { name: 'Save as new branch' }).click()
  await expect(user).toContainText('Edited')
  await expect(user.getByRole('img')).toHaveAttribute('src', dataUrl)
  await user.getByRole('button', { name: 'Generate response', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  await expect(page.getByRole('article', { name: 'User message' }).filter({ hasText: 'Edited' })).toHaveCount(1)
  await page.locator('#threads-panel').getByRole('button', { name: 'Large log review', exact: true }).click()
  await page.locator('#threads-panel').getByRole('button', { name: 'Deterministic request architecture', exact: true }).click()
  await expect(page.getByRole('article', { name: 'User message' }).last().getByRole('img')).toHaveAttribute('src', dataUrl)
})

test('switching to text-only blocks image drafts and included image history without losing them', async ({ page }) => {
  await open(page)
  await page.getByLabel('Choose images').setInputFiles(image)
  await page.getByLabel('Message input').fill('Question')
  await page.getByRole('main').getByRole('button', { name: /Vision/ }).click()
  await page.getByRole('option', { name: /Text only/ }).click()
  await expect(page.getByRole('status')).toContainText('Image input is disabled')
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Attach images' })).toBeDisabled()
  await page.getByRole('main').getByRole('button', { name: /Text only/ }).click()
  await page.getByRole('option', { name: /Vision/ }).click()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  await page.getByRole('combobox', { name: 'History', exact: true }).selectOption('full')
  await page.getByLabel('Message input').fill('Follow up')
  await page.getByRole('main').getByRole('button', { name: /Vision/ }).click()
  await page.getByRole('option', { name: /Text only/ }).click()
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toBeDisabled()
  await page.getByRole('combobox', { name: 'History', exact: true }).selectOption('no_history')
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
  await expect(page.getByRole('article', { name: 'User message' }).last().getByRole('img')).toHaveAttribute('src', dataUrl)
})

test('image attachment validates format, bytes, size and count; paste and drop stay local', async ({ page }) => {
  await open(page)
  const picker = page.getByLabel('Choose images')
  await picker.setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('not an image') })
  await expect(page.getByRole('alert')).toContainText('does not match')
  await picker.setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) })
  await expect(page.getByRole('alert')).toContainText('5 MiB')
  await picker.setInputFiles(Array.from({ length: 5 }, () => image))
  await expect(page.getByRole('alert')).toContainText('at most 4')
  await page.getByLabel('Message input').evaluate((element, png) => {
    const data = new DataTransfer()
    data.items.add(new File([Uint8Array.from(atob(png), (ch) => ch.charCodeAt(0))], 'pasted.png', { type: 'image/png' }))
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, png)
  await expect(page.getByRole('button', { name: 'Remove image pasted.png' })).toBeVisible()
  await page.getByRole('form', { name: 'Send message' }).evaluate((element, png) => {
    const data = new DataTransfer()
    data.items.add(new File([Uint8Array.from(atob(png), (ch) => ch.charCodeAt(0))], 'dropped.png', { type: 'image/png' }))
    element.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
  }, png)
  await expect(page.getByRole('button', { name: 'Remove image dropped.png' })).toBeVisible()
  await page.getByRole('button', { name: 'Remove image pasted.png' }).click()
  await expect(page.getByRole('button', { name: 'Remove image pasted.png' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Remove image dropped.png' })).toBeVisible()
})

test('image support is explicitly enabled per service/model and saved locally', async ({ page }) => {
  await open(page, 'nvidia-nim', 'openai_chat_completions', false)
  await expect(page.getByRole('button', { name: 'Attach images' })).toBeDisabled()
  await page.getByRole('main').getByRole('button', { name: 'Provider settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Provider settings' })
  await settings.getByRole('button', { name: /^Vision/ }).click()
  await settings.getByLabel('Enable image input').check()
  await settings.getByRole('button', { name: 'Save model', exact: true }).click()
  await settings.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Attach images' })).toBeEnabled()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Attach images' })).toBeEnabled()
  await page.getByRole('main').getByRole('button', { name: /Vision/ }).click()
  await page.getByRole('option', { name: /Text only/ }).click()
  await expect(page.getByRole('button', { name: 'Attach images' })).toBeDisabled()
})

test('failed sends keep the draft and images; compact composers stay usable with compatibility warnings', async ({ page }) => {
  await page.route('**/src/lib/backend.ts*', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, body: `${await response.text()}
      const originalSendMessage = sendMessage;
      let failImageSend = true;
      sendMessage = async (...args) => {
        if (failImageSend) { failImageSend = false; throw new Error('Could not start image request'); }
        return originalSendMessage(...args);
      };` })
  })
  await open(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByLabel('Choose images').setInputFiles(image)
  await page.getByLabel('Message input').fill('Keep my draft')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Could not start image request')
  await expect(page.getByLabel('Message input')).toHaveValue('Keep my draft')
  await expect(page.getByRole('button', { name: 'Remove image sample.png' })).toBeVisible()
  await page.getByRole('main').getByRole('button', { name: /Vision/ }).click()
  await page.getByRole('option', { name: /Text only/ }).click()
  await expect(page.getByRole('status')).toBeVisible()
  const input = (await page.getByLabel('Message input').boundingBox())!
  expect(input.height).toBeGreaterThanOrEqual(32)
  expect(input.x).toBeGreaterThanOrEqual(0)
  expect(input.x + input.width).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await page.screenshot({ path: '/tmp/cerachat-images-mobile.png' })
})
