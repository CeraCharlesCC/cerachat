import { unzipSync } from 'fflate'

export const MAX_SOURCE_BYTES = 16 * 1024 * 1024
const MAX_BATCH_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 256
const TEXT_FILE = /\.(txt|md|json|log|csv)$/i

export interface BrowserSourceFile {
  name: string
  originPath: string
  archivePath: string | null
  text: string
}

function decodeText(bytes: Uint8Array, name: string): string {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
    if (text.includes('\0')) throw new Error('Binary data')
    return text
  } catch {
    throw new Error(`${name}: expected UTF-8 or UTF-16 text with a BOM; convert the file to UTF-8 and try again.`)
  }
}

function safeArchivePath(name: string): string | null {
  const normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.endsWith('/')
    || normalized.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\0'))) return null
  return normalized
}

/** Runs in the database Worker. Read and validate the entire selection before
 * storing anything. ZIP contents are never extracted to the filesystem. */
export async function readBrowserSourceFiles(files: File[]): Promise<BrowserSourceFile[]> {
  if (files.length > MAX_ENTRIES || files.reduce((total, file) => total + file.size, 0) > MAX_BATCH_BYTES) {
    throw new Error('Select at most 256 files and 64 MiB per import.')
  }
  const sources: BrowserSourceFile[] = []
  let totalBytes = 0
  const add = (name: string, originPath: string, archivePath: string | null, bytes: Uint8Array) => {
    if (bytes.length > MAX_SOURCE_BYTES) throw new Error(`${name}: text file exceeds the 16 MiB limit.`)
    const text = decodeText(bytes, name)
    const size = new TextEncoder().encode(text).length
    if (size > MAX_SOURCE_BYTES) throw new Error(`${name}: decoded text exceeds the 16 MiB limit.`)
    totalBytes += size
    if (totalBytes > MAX_BATCH_BYTES || sources.length >= MAX_ENTRIES) throw new Error('Imported text exceeds 64 MiB or 256 entries.')
    sources.push({ name, originPath, archivePath, text })
  }
  for (const file of files) {
    if (TEXT_FILE.test(file.name)) {
      if (file.size > MAX_SOURCE_BYTES) throw new Error(`${file.name}: text file exceeds the 16 MiB limit.`)
      add(file.name, file.name, null, new Uint8Array(await file.arrayBuffer()))
    } else if (/\.zip$/i.test(file.name)) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (bytes.length < 22) throw new Error(`${file.name}: invalid ZIP archive.`)
      const entries = new Map<string, { path: string; size: number }>()
      const paths = new Set<string>()
      let inflated = 0
      let count = 0
      const contents = unzipSync(bytes, { filter(info) {
        if (++count > 4096) throw new Error(`${file.name}: ZIP has too many entries.`)
        const path = safeArchivePath(info.name)
        if (!path || !TEXT_FILE.test(path)) return false
        if (paths.has(path)) throw new Error(`${file.name}: duplicate ZIP entry ${path}.`)
        paths.add(path)
        if (!Number.isSafeInteger(info.originalSize) || info.originalSize < 0
          || info.originalSize > MAX_SOURCE_BYTES || !Number.isSafeInteger(info.size)
          || info.size < 0 || info.size > bytes.length || ![0, 8].includes(info.compression)) {
          throw new Error(`${file.name}: unsupported ZIP entry size or compression: ${path}.`)
        }
        inflated += info.originalSize
        if (totalBytes + inflated > MAX_BATCH_BYTES || sources.length + entries.size >= MAX_ENTRIES) {
          throw new Error('Imported text exceeds 64 MiB or 256 entries.')
        }
        entries.set(info.name, { path, size: info.originalSize })
        return true
      } })
      for (const [name, entry] of entries) {
        const content = contents[name]
        if (!content || content.length !== entry.size) throw new Error(`${file.name}: invalid ZIP entry ${entry.path}.`)
        add(`${file.name} / ${entry.path}`, file.name, entry.path, content)
      }
    }
  }
  if (!sources.length) throw new Error('No supported TXT/MD/JSON/LOG/CSV files were found (including ZIP contents).')
  return sources
}
