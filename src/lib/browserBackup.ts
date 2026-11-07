/** Explicit, local-only browser backup/restore. No provider API keys enter an archive. */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { BROWSER_PROVIDER_STORAGE_KEY, saveModel, saveProvider } from './backend'
import { importSnapshot, exportSnapshot } from './browserStorage'
import { validateProviderCatalog } from './catalog'
import type { ModelProfile, ProviderCatalog, ProviderProfile } from '../types'

const FORMAT = 'cerachat-browser-backup'
const VERSION = 1
const MAX_DB_BYTES = 256 * 1024 * 1024 // Must match the worker's import cap.
const MAX_SETTINGS_BYTES = 1024 * 1024
const MAX_MANIFEST_BYTES = 16 * 1024
export const MAX_ARCHIVE_BYTES = MAX_DB_BYTES + MAX_SETTINGS_BYTES + MAX_MANIFEST_BYTES + 4096
const ENTRY_LIMITS: Record<string, number> = {
  'manifest.json': MAX_MANIFEST_BYTES,
  'chat.sqlite3': MAX_DB_BYTES,
  'settings.json': MAX_SETTINGS_BYTES,
}

export interface BackupManifest {
  format: typeof FORMAT
  version: typeof VERSION
  created_at: string
  database: { file: 'chat.sqlite3'; bytes: number; sha256: string }
  settings: { file: 'settings.json'; bytes: number; sha256: string }
}

export interface BrowserBackup {
  manifest: BackupManifest
  database: Uint8Array
  settings: ProviderCatalog
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function assertDatabase(bytes: Uint8Array): void {
  if (bytes.length < 512 || bytes.length > MAX_DB_BYTES || strFromU8(bytes.subarray(0, 16)) !== 'SQLite format 3\0') {
    throw new Error('Backup must contain a supported SQLite database snapshot')
  }
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(hash, (value) => value.toString(16).padStart(2, '0')).join('')
}

function assertManifest(value: unknown): asserts value is BackupManifest {
  if (!isRecord(value) || !hasKeys(value, ['format', 'version', 'created_at', 'database', 'settings'])
    || value.format !== FORMAT || value.version !== VERSION || typeof value.created_at !== 'string'
    || !Number.isFinite(Date.parse(value.created_at))) {
    throw new Error('Unsupported or malformed CeraChat backup manifest')
  }
  for (const [kind, file] of [['database', 'chat.sqlite3'], ['settings', 'settings.json']] as const) {
    const entry = value[kind]
    if (!isRecord(entry) || !hasKeys(entry, ['file', 'bytes', 'sha256']) || entry.file !== file
      || !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) <= 0
      || (entry.bytes as number) > ENTRY_LIMITS[file]
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`Malformed ${kind} descriptor in backup manifest`)
    }
  }
}

/** Pure packer, also used by tests. The database is stored uncompressed to bound memory usage. */
export async function packBrowserBackup(database: Uint8Array, settings: ProviderCatalog): Promise<Uint8Array> {
  assertDatabase(database)
  validateProviderCatalog(settings)
  // Explicitly use only the nonsecret catalog. The separate localStorage
  // envelope's secrets.api_keys map is never read or included here.
  const settingsBytes = strToU8(JSON.stringify(settings))
  if (settingsBytes.length > MAX_SETTINGS_BYTES) throw new Error('Provider settings exceed the backup limit')
  const manifest: BackupManifest = {
    format: FORMAT,
    version: VERSION,
    created_at: new Date().toISOString(),
    database: { file: 'chat.sqlite3', bytes: database.length, sha256: await digest(database) },
    settings: { file: 'settings.json', bytes: settingsBytes.length, sha256: await digest(settingsBytes) },
  }
  const manifestBytes = strToU8(JSON.stringify(manifest))
  if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error('Backup manifest exceeds the limit')
  const archive = zipSync({
    'manifest.json': [manifestBytes, { level: 0 }],
    'chat.sqlite3': [database, { level: 0 }],
    'settings.json': [settingsBytes, { level: 0 }],
  }, { level: 0 })
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('Backup archive exceeds the size limit')
  return archive
}

export async function createBrowserBackup(catalog: ProviderCatalog): Promise<Uint8Array> {
  return packBrowserBackup(await exportSnapshot(), catalog)
}

/** Validate filenames, file count, inflated sizes, schema version and hashes before any DB write. */
export async function inspectBrowserBackup(bytes: Uint8Array): Promise<BrowserBackup> {
  if (bytes.length < 64 || bytes.length > MAX_ARCHIVE_BYTES) {
    throw new Error('Backup ZIP file is empty or exceeds the supported size limit')
  }
  const seen = new Set<string>()
  let inflated = 0
  const files = unzipSync(bytes, {
    filter(info) {
      const limit = ENTRY_LIMITS[info.name]
      if (limit === undefined || seen.has(info.name)) throw new Error(`Unexpected or duplicate backup entry: ${info.name}`)
      seen.add(info.name)
      if (!Number.isSafeInteger(info.originalSize) || info.originalSize <= 0 || info.originalSize > limit
        || !Number.isSafeInteger(info.size) || info.size < 0
        || (info.compression !== 0 && info.compression !== 8)) {
        throw new Error(`Backup entry has an unsupported size or compression method: ${info.name}`)
      }
      inflated += info.originalSize
      if (inflated > MAX_DB_BYTES + MAX_SETTINGS_BYTES + MAX_MANIFEST_BYTES) {
        throw new Error('Backup uncompressed content exceeds the size limit')
      }
      return true
    },
  })
  if (seen.size !== 3 || Object.keys(files).length !== 3) {
    throw new Error('Backup must contain exactly manifest.json, chat.sqlite3 and settings.json')
  }
  for (const [filename, limit] of Object.entries(ENTRY_LIMITS)) {
    if (!files[filename] || files[filename].length > limit || files[filename].length === 0) {
      throw new Error(`Missing or oversized backup entry: ${filename}`)
    }
  }
  const rawManifest: unknown = JSON.parse(strFromU8(files['manifest.json']))
  assertManifest(rawManifest)
  const database = files['chat.sqlite3']
  const settingsBytes = files['settings.json']
  if (rawManifest.database.bytes !== database.length || rawManifest.settings.bytes !== settingsBytes.length) {
    throw new Error('Backup entry sizes do not match the manifest')
  }
  assertDatabase(database)
  if (await digest(database) !== rawManifest.database.sha256 || await digest(settingsBytes) !== rawManifest.settings.sha256) {
    throw new Error('Backup checksum mismatch; the archive may be damaged')
  }
  const settings: unknown = JSON.parse(strFromU8(settingsBytes))
  validateProviderCatalog(settings)
  return { manifest: rawManifest, database, settings }
}

export async function inspectBrowserBackupFile(file: File): Promise<BrowserBackup> {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error('Backup ZIP exceeds the supported size limit')
  return inspectBrowserBackup(new Uint8Array(await file.arrayBuffer()))
}

/** Never overwrite an existing provider: it might own a local API key. */
export function settingsAdditions(current: ProviderCatalog, incoming: ProviderCatalog): {
  providers: ProviderProfile[]; models: ModelProfile[]
} {
  validateProviderCatalog(current)
  validateProviderCatalog(incoming)
  const currentIds = new Set(current.providers.map((provider) => provider.id))
  const providers = incoming.providers.filter((provider) => !currentIds.has(provider.id))
  const newIds = new Set(providers.map((provider) => provider.id))
  const models = incoming.models.filter((model) => newIds.has(model.provider_id))
  return { providers, models }
}

/** Database replace is worker-validated; optional settings merge preserves existing keys. */
export async function restoreBrowserBackup(
  backup: BrowserBackup,
  currentCatalog: ProviderCatalog,
  addMissingSettings: boolean,
): Promise<void> {
  const changes = addMissingSettings ? settingsAdditions(currentCatalog, backup.settings) : { providers: [], models: [] }
  const needsMerge = changes.providers.length > 0 || changes.models.length > 0
  // The extra snapshot allows rollback if an opted-in settings write fails.
  const oldDatabase = needsMerge ? await exportSnapshot() : null
  const oldSettings = needsMerge ? localStorage.getItem(BROWSER_PROVIDER_STORAGE_KEY) : null
  await importSnapshot(backup.database)
  if (!needsMerge) return
  try {
    for (const provider of changes.providers) await saveProvider(provider, null)
    for (const model of changes.models) await saveModel(model)
  } catch (error) {
    const failures: string[] = []
    try { await importSnapshot(oldDatabase!) } catch (reason) { failures.push(`database rollback failed: ${String(reason)}`) }
    try {
      if (oldSettings === null) localStorage.removeItem(BROWSER_PROVIDER_STORAGE_KEY)
      else localStorage.setItem(BROWSER_PROVIDER_STORAGE_KEY, oldSettings)
    } catch (reason) { failures.push(`settings rollback failed: ${String(reason)}`) }
    throw new Error(`Backup restore failed: ${String(error)}. ${failures.length ? failures.join('; ') : 'Original data was restored.'}`)
  }
}
