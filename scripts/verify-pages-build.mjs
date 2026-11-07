import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { open, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const base = '/cerachat/'
const port = Number(process.env.PAGES_PREVIEW_PORT || 4178)
const host = `http://127.0.0.1:${port}`

async function listFiles(directory, prefix = '') {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const name = join(prefix, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(directory, name))
    else if (entry.isFile()) files.push(name.replaceAll(sep, '/'))
  }
  return files
}

async function main() {
  const html = await readFile(join(dist, 'index.html'), 'utf8')
  const htmlUrls = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((url) => url.startsWith('/'))
  assert.ok(htmlUrls.length > 0, 'index.html must reference built assets')

  // Reject absolute-root URLs: those would break on a project Pages subpath.
  for (const url of htmlUrls) {
    assert.ok(url.startsWith(base), `Asset URL must begin with ${base}: ${url}`)
    const pathname = new URL(url, host).pathname
    const file = resolve(dist, decodeURIComponent(pathname.slice(base.length)))
    const relativePath = relative(dist, file)
    assert.ok(relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath),
      `Asset URL escapes dist: ${url}`)
    assert.ok((await stat(file)).isFile(), `Missing emitted asset: ${url}`)
  }

  const files = await listFiles(dist)
  assert.ok(files.some((name) => name.endsWith('.js')), 'Expected a bundled JavaScript asset')

  // Verify every bundled JS file (including Worker chunks) and every WASM file
  // loads with the expected MIME type from a real Vite preview HTTP server.
  const urls = new Set([base, ...htmlUrls])
  for (const file of files) {
    if (['.js', '.css', '.wasm'].includes(extname(file))) urls.add(base + file)
    if (file.endsWith('.wasm')) {
      const handle = await open(join(dist, file), 'r')
      try {
        const magic = Buffer.alloc(4)
        await handle.read(magic, 0, 4, 0)
        assert.equal(magic.toString('hex'), '0061736d', `Invalid WASM asset: ${file}`)
      } finally {
        await handle.close()
      }
    }
  }

  const server = spawn(process.execPath, [
    join(root, 'node_modules/vite/bin/vite.js'), 'preview',
    '--mode', 'github-pages', '--host', '127.0.0.1',
    '--port', String(port), '--strictPort',
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let serverLog = ''
  server.stdout.on('data', (chunk) => { serverLog += chunk.toString() })
  server.stderr.on('data', (chunk) => { serverLog += chunk.toString() })

  try {
    let ready = false
    for (let i = 0; i < 80; i++) {
      if (server.exitCode !== null) break
      try {
        const result = await fetch(host + base, {
          method: 'HEAD', signal: AbortSignal.timeout(1000),
        })
        if (result.ok) { ready = true; break }
      } catch { /* preview is still starting */ }
      await new Promise((resolveWait) => setTimeout(resolveWait, 150))
    }
    assert.ok(ready, `Pages preview did not start:\n${serverLog}`)

    for (const url of urls) {
      const response = await fetch(host + url, {
        method: 'HEAD', signal: AbortSignal.timeout(5000),
      })
      assert.equal(response.status, 200, `Unable to serve ${url}: ${response.status}`)
      const mime = response.headers.get('content-type') ?? ''
      const extension = extname(new URL(url, host).pathname)
      if (extension === '.js') assert.match(mime, /javascript/, `JS MIME for ${url}`)
      if (extension === '.css') assert.match(mime, /^text\/css/, `CSS MIME for ${url}`)
      if (extension === '.wasm') assert.match(mime, /^application\/wasm/, `WASM MIME for ${url}`)
      if (url === base) assert.match(mime, /^text\/html/, 'HTML MIME')
    }
    console.log(`Pages smoke test passed: ${urls.size} URL(s) served under ${base}`)
  } finally {
    server.kill('SIGTERM')
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
