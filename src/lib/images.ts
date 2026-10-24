import type { ImageAttachment, ProviderProtocol } from '../types'

export const MAX_IMAGES = 4
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_REQUEST_IMAGE_URL_BYTES = 28 * 1024 * 1024
export const IMAGE_INPUT_HELP = 'Image input is disabled for this service/model. Enable it in Provider settings only if supported.'

export function validateImages(images: ImageAttachment[]) {
  if (images.length > MAX_IMAGES) throw new Error('Attach at most 4 images per message.')
  for (const image of images) {
    if (!image.name.trim() || new TextEncoder().encode(image.name).length > 1024) throw new Error('Image name must contain 1–1024 bytes.')
    if (image.data_url.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64) throw new Error('Each image must be at most 5 MiB.')
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.data_url)
    if (!match) throw new Error('Use PNG, JPEG, or WebP images.')
    let data: string
    try { data = atob(match[2]) } catch { throw new Error('Invalid image base64.') }
    if (!data.length || data.length > MAX_IMAGE_BYTES) throw new Error('Each image must contain 1 byte to 5 MiB.')
    const valid = match[1] === 'png' ? data.startsWith('\x89PNG\r\n\x1a\n')
      : match[1] === 'jpeg' ? data.startsWith('\xff\xd8\xff')
        : data.startsWith('RIFF') && data.slice(8, 12) === 'WEBP'
    if (!valid) throw new Error('Image format does not match its file contents.')
  }
}

export async function readImages(files: File[]): Promise<ImageAttachment[]> {
  if (files.length > MAX_IMAGES) throw new Error('Attach at most 4 images per message.')
  return Promise.all(files.map(async (file) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Use PNG, JPEG, or WebP images.')
    if (!file.size || file.size > MAX_IMAGE_BYTES) throw new Error('Each image must contain 1 byte to 5 MiB.')
    const data_url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error(`Could not read ${file.name}`))
      reader.onabort = () => reject(new Error(`Reading ${file.name} was cancelled`))
      reader.readAsDataURL(file)
    })
    const image = { name: file.name, data_url }
    validateImages([image])
    // Verify it can be decoded locally before keeping it in the draft.
    await new Promise<void>((resolve, reject) => {
      const preview = new Image()
      preview.onload = () => resolve()
      preview.onerror = () => reject(new Error(`Could not decode ${file.name}`))
      preview.src = data_url
    })
    return image
  }))
}

export function imageContent(text: string, images: ImageAttachment[], protocol: ProviderProtocol) {
  if (!images.length) return text
  const responses = protocol === 'openai_responses'
  return [
    ...(text ? [{ type: responses ? 'input_text' : 'text', text }] : []),
    ...images.map((image) => responses
      ? { type: 'input_image', image_url: image.data_url }
      : { type: 'image_url', image_url: { url: image.data_url } }),
  ]
}
