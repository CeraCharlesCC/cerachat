import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Modal } from '../ui/Modal'
import type { ImageAttachment } from '../../types'

export function ImageAttachments({ images, onRemove, disabled }: { images: ImageAttachment[]; onRemove?: (index: number) => void; disabled?: boolean }) {
  const [opened, setOpened] = useState<ImageAttachment | null>(null)
  if (!images.length) return null
  return <><ul aria-label="Image attachments" className="m-0 flex max-h-32 shrink-0 list-none gap-2 overflow-auto p-1">
    {images.map((image, index) => <li key={index} className="flex w-24 shrink-0 flex-col gap-1 rounded-lg border border-border bg-background p-1">
      <button type="button" aria-label={`View image ${image.name}`} onClick={() => setOpened(image)}><img src={image.data_url} alt={image.name} className="h-14 w-full rounded object-contain" /></button>
      <span className="truncate text-[10px]" title={image.name}>{image.name}</span>
      {onRemove && <button type="button" disabled={disabled} className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50" aria-label={`Remove image ${image.name}`} onClick={() => onRemove(index)}>Remove</button>}
    </li>)}
  </ul>{opened && createPortal(<Modal title={opened.name} wide onClose={() => setOpened(null)}><img src={opened.data_url} alt={opened.name} className="mx-auto max-h-[70dvh] max-w-full object-contain" /></Modal>, document.body)}</>
}
