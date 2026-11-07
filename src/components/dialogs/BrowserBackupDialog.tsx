import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'
import {
  createBrowserBackup,
  inspectBrowserBackupFile,
  restoreBrowserBackup,
  settingsAdditions,
  type BrowserBackup,
} from '../../lib/browserBackup'
import type { ProviderCatalog } from '../../types'

function bytesLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++ }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export function BrowserBackupDialog({ catalog, disabled, onClose }: {
  catalog: ProviderCatalog
  disabled: boolean
  onClose: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ name: string; backup: BrowserBackup } | null>(null)
  const [includeSettings, setIncludeSettings] = useState(false)
  const [usage, setUsage] = useState<{ used?: number; quota?: number } | null>(null)
  const [persistent, setPersistent] = useState<boolean | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null)
  const locked = busy || disabled

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        if (!navigator.storage?.estimate) throw new Error('Storage estimates are unavailable in this browser')
        const estimate = await navigator.storage.estimate()
        const saved = navigator.storage.persisted ? await navigator.storage.persisted() : null
        if (active) {
          setUsage({ used: estimate.usage, quota: estimate.quota })
          setPersistent(saved)
        }
      } catch (reason) { if (active) setStorageError(errorMessage(reason)) }
    })()
    return () => { active = false }
  }, [])

  const downloadBackup = async () => {
    if (locked) return
    setBusy(true)
    setStatus(null)
    setError(null)
    try {
      const bytes = await createBrowserBackup(catalog)
      const blob = new Blob([new Uint8Array(bytes)], { type: 'application/zip' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `cerachat-backup-${new Date().toISOString().replace(/:/g, '-')}.zip`
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setStatus(`Backup prepared (${bytesLabel(blob.size)}). Store it securely and verify you can restore it.`)
    } catch (reason) { setError(errorMessage(reason)) }
    finally { setBusy(false) }
  }

  const chooseBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file || locked) return
    setBusy(true)
    setStatus(null)
    setError(null)
    setSelected(null)
    setIncludeSettings(false)
    try { setSelected({ name: file.name, backup: await inspectBrowserBackupFile(file) }) }
    catch (reason) { setError(errorMessage(reason)) }
    finally { setBusy(false) }
  }

  const restore = async () => {
    if (locked || !selected) return
    const message = `REPLACE this browser's CeraChat conversation history, branches, sources, and request audits with the backup from ${selected.backup.manifest.created_at}?\n\n` +
      `This cannot be undone. Export your current workspace first. Existing provider API keys will not be imported or removed. ` +
      (includeSettings ? 'Only missing providers/models will be added; existing provider connections and keys are untouched.'
        : 'Current provider settings and API keys will remain unchanged.')
    if (!window.confirm(message)) return
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      await restoreBrowserBackup(selected.backup, catalog, includeSettings)
      // A full reload discards old in-memory UI state after the verified replace.
      window.location.reload()
    } catch (reason) { setError(errorMessage(reason)); setBusy(false) }
  }

  const requestPersistence = async () => {
    if (locked || !navigator.storage?.persist) return
    setBusy(true)
    setStatus(null)
    setError(null)
    try {
      const granted = await navigator.storage.persist()
      setPersistent(granted)
      setStatus(granted
        ? 'Persistent storage granted by the browser. Manual backups are still necessary.'
        : 'The browser did not grant persistent storage. Save regular backups.')
    } catch (reason) { setError(errorMessage(reason)) }
    finally { setBusy(false) }
  }

  const additions = selected ? settingsAdditions(catalog, selected.backup.settings) : null
  const canPersist = typeof navigator.storage?.persist === 'function'

  return (
    <Modal title="Browser backups and storage" wide onClose={() => { if (!busy) onClose() }} footer={
      <Button variant="outline" disabled={busy} onClick={onClose}>Close</Button>
    }>
      <div className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          Local data belongs to this exact website origin. Clearing site data, switching domains, and
          browser eviction can permanently remove it. A local save is not a backup.
        </p>

        <section className="space-y-2 rounded-xl border border-border/70 p-4" aria-label="Download backup">
          <h3 className="font-semibold">Export a backup</h3>
          <p className="text-xs text-muted-foreground">
            Download a versioned ZIP containing chat.sqlite3 and nonsecret provider settings.
            CeraChat's saved API keys are excluded. Custom provider URLs and text may still contain
            sensitive information: protect the archive before sharing it.
          </p>
          <Button variant="primary" disabled={locked} onClick={() => void downloadBackup()}>
            {busy ? 'Working...' : 'Download backup ZIP'}
          </Button>
        </section>

        <section className="space-y-3 rounded-xl border border-border/70 p-4" aria-label="Restore backup">
          <h3 className="font-semibold">Restore (replace current conversations)</h3>
          <p className="text-xs text-muted-foreground">
            Validate a CeraChat ZIP before replacing this browser's database. Import does not
            change your stored provider API keys, and it never sends data to a server.
          </p>
          <input ref={inputRef} type="file" accept=".zip,application/zip" className="hidden"
            aria-label="Choose CeraChat backup ZIP" onChange={(event) => void chooseBackup(event)} />
          <Button variant="outline" disabled={locked} onClick={() => inputRef.current?.click()}>Choose backup ZIP</Button>
          {selected && (
            <div className="space-y-3 rounded-lg bg-muted/40 p-3 text-xs">
              <p className="break-all font-medium">{selected.name}</p>
              <p>Created {new Date(selected.backup.manifest.created_at).toLocaleString()};
                {' '}{bytesLabel(selected.backup.database.length)} database,
                {' '}{selected.backup.settings.providers.length} provider profile(s).
              </p>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5" checked={includeSettings}
                  disabled={locked} onChange={(event) => setIncludeSettings(event.target.checked)} />
                <span>Add missing provider settings from this backup
                  ({additions?.providers.length ?? 0} providers, {additions?.models.length ?? 0} models).
                  Existing providers, configurations and API keys are left unchanged.
                </span>
              </label>
              <Button variant="destructive" disabled={locked} onClick={() => void restore()}>
                Replace browser conversations with this backup
              </Button>
            </div>
          )}
        </section>

        <section className="space-y-2 rounded-xl border border-border/70 p-4" aria-label="Browser storage">
          <h3 className="font-semibold">Storage on this device</h3>
          {usage ? <p className="text-xs">Origin usage: {usage.used === undefined ? 'unknown' : bytesLabel(usage.used)};
            {' '}estimated quota: {usage.quota === undefined ? 'unknown' : bytesLabel(usage.quota)}.</p>
            : <p className="text-xs text-muted-foreground">{storageError ?? 'Checking browser storage...'}</p>}
          <p className="text-xs text-muted-foreground">
            Persistent storage may reduce automatic eviction, but does not protect against data
            clearing, device failure, or moving to a new origin.
          </p>
          <p className="text-xs">Persistent storage: {persistent === null ? 'unknown' : persistent ? 'granted' : 'not granted'}.</p>
          <Button variant="outline" disabled={locked || !canPersist || persistent === true}
            onClick={() => void requestPersistence()}>
            Request persistent storage
          </Button>
          {!canPersist && <p className="text-xs text-muted-foreground">This browser does not expose a storage persistence request.</p>}
        </section>

        {status && <p role="status" className="text-xs text-muted-foreground">{status}</p>}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
    </Modal>
  )
}
