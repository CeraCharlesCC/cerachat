# CeraChat

CeraChat is a local-first desktop chat client for deliberate use of OpenAI-compatible model APIs. Its goal is to make every model request a conscious, inspectable decision: what leaves the computer, when it leaves, and which conversation and context produced it.

## Design principles

- **Sending is a trust boundary.** Configuring a provider, working with local sources, editing a conversation, and inspecting a request must not contact a model. Only an explicit send or regeneration crosses that boundary. No automatic provider discovery, fallback, or background model calls should surprise the user.
- **The sent request is the audit record.** The preview makes the assembled request visible before sending; a snapshot of what was actually sent remains available afterward. Changes to context or conversation history must not silently rewrite past requests. Token estimates are guidance, not a substitute for inspecting the payload.
- **Context is chosen, not inferred.** People decide which sources and excerpts to include, where they appear, and in what order. Sources belong to a chat, are shared by its branches, and are reused across chats only by an explicit choice. Hidden retrieval, summarization, or context injection would undermine that control.
- **Exploration should preserve history.** Editing messages or reasoning and regenerating answers creates alternatives rather than overwriting the original branch. Keeping the old path supports comparison and makes past decisions understandable.
- **Compatibility must not be guessed.** An OpenAI-compatible endpoint may support different parameters, images, or reasoning formats. Model names are not a capability test. Prefer explicit settings and visible errors to silently dropping, rewriting, or inventing content to make a request succeed.
- **Local-first means user-owned and user-protected.** There is no automatic cloud sync or telemetry. Portability should not obscure the fact that conversations, imported material, and request records can be sensitive.
- **The scope is intentionally narrow.** This is a chat client, not an autonomous agent or a web-search or MCP runtime. Users retain responsibility for selecting and sending the information a provider receives.

## Using CeraChat

Configure a provider and model, choose a chat branch, attach only the local context and images you want to share, inspect the request preview, then send. You can revisit or branch earlier messages without changing the request records associated with them. Both the desktop app and supported browsers can send explicit provider requests; browser transport works only with CORS-compatible providers. The browser edition imports pasted text and restores local ZIP backups, while desktop-specific source file import remains available in Tauri.

**Check the actual provider and model documentation before enabling optional capabilities.** Image input, custom parameters, and reasoning replay are not uniformly supported by OpenAI-compatible APIs. The request preview exposes the data selected for transmission, including images; token estimates cover text rather than image costs. Edited or replayed plaintext reasoning is an experiment, not a reconstruction of a provider's signed, encrypted, or otherwise protected reasoning state. Even a preserved request cannot guarantee an identical future model response.

**Protect the portable data directory.** It can contain conversation history, imported content, image data, and complete request payloads. Desktop provider API keys are currently stored there in plaintext. Do not place this directory on an untrusted or publicly shared drive. In the browser, provider keys are session-only by default; remembering a key on this device requires an explicit opt-in and stores it locally. Browser ZIP backups exclude saved API keys.

## Development

Use Node.js 22 and the Rust toolchain specified in [`rust-toolchain.toml`](rust-toolchain.toml). For a browser preview:

```sh
npm ci
npm run dev
```

For the desktop app, install the [Tauri development prerequisites](https://v2.tauri.app/start/prerequisites/) and CLI, then start it from the repository root:

```sh
cargo install tauri-cli --version '^2'
cargo tauri dev
```

The [package scripts](package.json) and [CI workflow](.github/workflows/ci.yml) define the checks and build process, including Windows portable artifacts. Consult the workflow result rather than assuming a build artifact is a release.

For `npm run test:e2e`, install or update Google Chrome Stable. Tests reuse system Chrome with Chromium sandboxing enabled; no bundled browser download is needed. Run as a non-root user on a host that supports the sandbox. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select another up-to-date Chrome executable.

### Browser edition on GitHub Pages

The browser edition is experimental; portability, upgrades and cross-browser support are still being validated. Its planned project URL is
`https://ceracharlescc.github.io/cerachat/`. In the repository's **Settings > Pages**,
choose **GitHub Actions** as the publishing source. The [Pages workflow](.github/workflows/pages.yml)
builds and deploys `dist/` on pushes to `master` (or via manual workflow dispatch).
Manual dispatches deploy only the `master` branch. The repository's GitHub Pages
deployment environment must permit that branch.

Pages builds use `npm run build -- --mode github-pages` to set Vite's asset base to
`/cerachat/`; normal `npm run dev` and `npm run build` retain `/` for local use
and Tauri. To smoke-test Pages asset paths and MIME handling locally:

```sh
npm run build -- --mode github-pages
node scripts/verify-pages-build.mjs
```

The smoke test checks the emitted HTML URLs and serves all emitted JS/CSS/WASM
assets (including Worker chunks) from a Pages-style subpath using Vite's preview
server. After deployment, also inspect the **actual** site's browser Network
panel for missing Worker/WASM files and wrong content types (`application/wasm`
for `.wasm`, JavaScript MIME for Workers). Local preview cannot guarantee the
host's response headers. GitHub Pages does not provide custom COOP/COEP response
headers, so the browser SQLite implementation must work without them. Offline
reload is not guaranteed unless offline caching is explicitly implemented.

Persistent browser data uses SQLite WASM in a Web Worker backed by OPFS and the
`opfs-sahpool` VFS. This requires browsers that support both OPFS and Web Locks;
there is no ephemeral in-memory fallback when storage is unavailable. Only one
tab can own the database at a time. Close other CeraChat tabs before trying
again if the workspace is locked. The persistence and recovery path has been
tested in current Chrome; compatibility with Firefox, Safari, private browsing,
storage-denied situations, and schema upgrades still needs separate validation.

**Browser storage is tied to the exact site origin.** Browser-managed local data
does not automatically move between `github.io`, custom domains, localhost, or
other devices, and clearing site data can remove it. Export a backup **before**
changing hosts/domains or clearing site data. The **Backups and storage** dialog
can download a versioned ZIP with `manifest.json`, a verified `chat.sqlite3`
snapshot, and nonsecret `settings.json`, then validate and replace browser
conversation data from a selected ZIP after explicit confirmation. Import keeps
existing provider keys and settings intact by default; optionally it can add
missing providers and models without changing existing connection profiles or
API keys. Archives and database imports are size-bounded (256 MiB SQLite limit)
and malformed imports are rejected before replacing the current database. The
dialog also shows the browser's storage usage/quota estimates and provides an
**opt-in** persistence request; neither persistent storage nor a successful save
replaces keeping backups. Protect downloaded archives, which may contain
sensitive conversation text and custom provider settings.

Browser provider requests require an endpoint that allows cross-origin JSON
`POST` requests, including any `Authorization` header, CORS `OPTIONS` preflight,
and streaming responses. A static browser site cannot bypass provider CORS
restrictions; use the desktop app or a proxy you operate and trust if needed.
Never embed shared API keys into a public static build. Requests must only be
sent on an explicit user action; the static site has no implicit proxy or
automatic retry mechanism.

## Where behavior is defined

Treat implementation and tests as the source of truth for behavior, not this README. Desktop request compilation and API payload construction live in [`src-tauri/src/context/compiler.rs`](src-tauri/src/context/compiler.rs); desktop provider transport lives in [`src-tauri/src/providers/`](src-tauri/src/providers/). Desktop storage and migrations live in [`src-tauri/src/db/`](src-tauri/src/db/) and [`src-tauri/src/portable/`](src-tauri/src/portable/). The frontend, browser SQLite Worker, provider transport, and backup logic live in [`src/`](src/). [Rust tests](src-tauri/src/) and [end-to-end tests](tests/) capture the observable contracts.

When changing a limit, setting, API field, UI control, or data format, change its defining code and tests. Update documentation when the **purpose, trust boundary, design trade-off, or user-facing risk** changes; do not maintain parallel tables of implementation details here.
