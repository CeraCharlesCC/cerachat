# CeraChat

CeraChat is a local-first chat client for OpenAI-compatible APIs, available as a desktop app and in the browser. You choose what context goes into each conversation and can inspect a model request before sending it.

## Features

- **Bring your own models:** configure providers using the OpenAI Chat Completions or Responses API.
- **Inspect requests:** preview the exact payload before sending and review saved request records afterward.
- **Control context:** select conversation history, text sources, and images instead of relying on automatic retrieval.
- **Explore branches:** edit messages and regenerate replies without losing earlier paths.
- **Keep data local:** chats are stored on your device, with ZIP backup and restore available in the browser edition.

## Get started

- **Browser (experimental):** [Open CeraChat](https://ceracharlescc.github.io/cerachat/). A recent Chrome browser is recommended; your API provider must allow browser requests (CORS).
- **Windows desktop:** download `CeraChat-windows-portable.zip` from a successful [CI run](https://github.com/CeraCharlesCC/cerachat/actions/workflows/ci.yml). These are build artifacts, not official releases.

In **Provider settings**, add an API endpoint and model (and an API key if required). Create a chat, choose any context to include, preview the request, and send.

## Development

Use **Node.js 22**. To run the browser edition locally:

```sh
npm ci
npm run dev
```

For the desktop edition, also install [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) and the Rust toolchain specified in [`rust-toolchain.toml`](rust-toolchain.toml), then run from the repository root:

```sh
cargo install tauri-cli --version '^2'
cargo tauri dev
```

Run `npm run lint`, `npm run build`, and `npm run test:e2e` for frontend checks (end-to-end tests require Google Chrome). The [CI workflow](.github/workflows/ci.yml) also runs Rust checks and builds the Windows portable app.

## Data and compatibility

CeraChat makes model requests only when you explicitly send or regenerate; it does not automatically sync conversations or send telemetry. Your selected content is sent to the configured model provider.

**Protect your local data.** Desktop API keys are currently stored in plaintext in the portable data directory. Browser API keys last for the tab session unless you opt to remember them on the device. Browser backups omit keys but can include sensitive conversation content. Export a backup from **Browser backups and storage** before clearing site data or changing domains.

Support for images, reasoning, and optional request parameters depends on the provider and model. The browser edition additionally requires a CORS-compatible API endpoint.
