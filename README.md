# CeraChat

CeraChat is a local-first Tauri 2 chat client built around one rule: the only model network access is the request the user explicitly compiles, inspects, and sends.

## v1 architecture

- **Desktop:** Tauri 2 + Rust
- **UI:** React + TypeScript + Vite
- **Storage:** SQLite with foreign keys, WAL, and cascade deletes
- **Providers:** manually configured OpenAI-compatible Chat Completions and Responses API endpoints, streaming over SSE
- **Context:** local TXT/MD/JSON/LOG/CSV text plus locally expanded ZIP entries
- **Blob storage:** SHA-256 content addressing with zstd compression

There are deliberately no tools, function calling, MCP, RAG, web search, model discovery, capability probes, auto-summarization, auto-title model calls, telemetry, cloud sync, or provider fallback loops.

## Request flow

1. Add providers and their models in **Provider settings**, then select a saved model from the header.
2. Choose a conversation branch and history policy.
3. Add local context sources and enable whole-file or line-range slices.
4. Choose raw/labeled wrapping, ordering, and insertion point per slice.
5. Open **Preview** to inspect the exact JSON, token estimate, compiled audit text, and SHA-256.
6. **Send** performs one HTTP POST. Redirects and automatic reqwest retries are disabled.
7. The exact request JSON, compiled prompt, SHA-256, and referenced context blob hashes are persisted for reproducibility.

Provider settings are saved locally without making a network request. The first Send is the first provider access.

## Editing and branches

Use the pencil beside any user or assistant message to edit it. **Save as new branch** stores a sibling with the same parent and inclusion setting; the original message, its descendants, and past request snapshots remain intact. An unchanged edit creates no extra message. Saving is local and never calls a provider. Use **Generate response** on the edited user message to request an answer, or continue typing after an edited assistant response.

The branch counter and left/right arrows beside a message switch between its alternatives and open the latest continuation of that alternative. The sidebar groups descendants under their parents. Switching conversations remembers the selected branch for the current app session. Navigation and destructive message actions are disabled during generation.

## Text attachments

**Add files** imports TXT/MD/JSON/LOG/CSV files or text entries from a ZIP. **Paste text** creates a local source directly. New attachments default to file labels after the current input. Expand **New attachment options** to change the default position/format or disable automatic inclusion when importing.

The source library and **Attachment order** list are separate: opening a source previews it, while the included list controls what goes into the next request. Drag an attachment's numbered grip, or use its up/down buttons, to change the order. Each attachment has an explicit insertion point and format. Within each insertion point, enabled attachments are joined in list order with the provider's context separator; raw mode preserves the selected text inside those boundaries. Request **Preview** shows the resulting JSON and compiled prompt before sending.

Repeatedly including the same source and range updates and enables its existing attachment instead of duplicating it. Reimporting unchanged text from the same path reuses the source; changed content remains a separate snapshot. Opening a source supports whole-file or validated line-range inclusion, pagination, and clicking line numbers (Shift-click sets the end). Original line endings and trailing empty lines are preserved in the compiled text.

Attachment order is saved in one database transaction. If another application instance changes which attachments exist, a stale reorder is rejected and refreshed. Removing a live source does not remove blobs referenced by past request logs. Context sources and inclusion settings remain workspace-wide.

The desktop window disables Tauri's native file-drop interception to allow the attachment list's HTML drag and drop to work in Windows WebView2 ([Tauri configuration reference](https://v2.tauri.app/reference/config/#dragdropenabled)). File import uses the file picker.

## Provider and model catalog

Create a provider with a stable ID, an editable display name, protocol, base URL, and optional API key. Save models manually under that provider with an API model ID, optional display name, context window, and maximum output tokens. System text, temperature, context separator, and JSON overrides belong to the provider; token limits belong to each model.

The header selector groups saved models by provider and searches provider names, model display names, and API model IDs. Selecting a model immediately saves its `providerId::modelId` identity. Restarting restores that exact pair. Provider and model IDs cannot contain `::`; provider IDs also cannot end with `:`. Model IDs such as `qwen3:8b` are supported.

Deleting the active model clears the selection. Deleting a provider also removes its models and stored API key. Neither operation chooses a replacement. Preview, Send, and regeneration require a selected model. Opening settings, editing the catalog, switching models, and previewing requests never contact a provider.

## Portable data

By default the desktop executable writes under a sibling `data/` directory:

```text
CeraChat/
├─ CeraChat.exe
└─ data/
   ├─ chat.sqlite3
   ├─ settings.json
   ├─ secrets.<generation-uuid>.json
   └─ logs/
```

Set `CERACHAT_DATA_DIR` to override the directory during development. v1 supports the explicit **Plain portable configuration** API-key mode; the Windows DPAPI choice is visible as planned but disabled rather than silently falling back.

`settings.json` uses the strict version-1 schema: `version`, `secret_generation`, `selected_model_id`, `providers`, and `models` are required. Provider fields match the catalog editor, including explicit nullable `temperature`; model fields include both IDs, the display name (which may be empty), and both token limits. `selected_model_id` is explicitly `null` when unselected. The referenced `secrets.<generation-uuid>.json` contains `version`, the matching `generation`, and `api_keys`, with one entry per provider (an empty string represents no key). API keys never appear in `settings.json`.

Saving writes a complete secret generation before atomically replacing `settings.json`, which commits the provider catalog and its matching secrets together. A file lock serializes reads and mutations across application instances. Obsolete generated secret files are cleaned on a best-effort basis; unrelated backup files are preserved. A fresh directory opens with an empty catalog. Existing settings are never migrated, repaired, or replaced during loading: old formats, missing fields, unknown versions, duplicate IDs, orphan models, unresolved selections, and inconsistent secrets produce a local error.

To configure from scratch after an incompatible file, close the application and explicitly move `settings.json` and all `secrets*.json` files out of the data directory, then reopen it. Keep `chat.sqlite3` to preserve conversations and context. Keep a copy of the moved files if you need their values while re-entering settings.

## Development

Use Node.js 22 and rustup. `rust-toolchain.toml` pins the Rust compiler and
components used by both local development and CI; update that file deliberately
when upgrading Rust so ordinary compiler releases do not invalidate build caches.

```bash
npm install
cargo install tauri-cli --version "^2"
cargo tauri dev
```

For a frontend-only browser preview:

```bash
npm run dev
```

The browser preview uses local demo data and simulates streaming. File import and real provider requests are desktop-only. Pasted text, branch editing, attachment ordering, and request compilation can also be exercised in the browser. Browser conversation/context data is demo data kept in memory for the current page lifetime; only the provider catalog persists across reloads.

The browser starts with an empty provider catalog and persists it in the `cerachat.provider-catalog.v1` localStorage entry. Its versioned envelope separates public `settings` from provider-keyed `secrets` and commits both in one storage operation. Invalid data fails locally without being rewritten. To start over explicitly, remove that entry using browser developer tools and reload.

## Verification

```bash
npm run lint
npm run build
npx playwright install chromium
npm run test:e2e
cd src-tauri
cargo fmt --all -- --check
cargo test --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
```

To use an installed Chromium browser, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when running `npm run test:e2e`. UI tests cover catalog persistence and validation, editing and branch restoration, generation from an existing user message, attachment ordering by arrows and drag, insertion positions, duplicate inclusion, line-range validation, compact layouts, and absence of provider traffic during local configuration and editing.

Rust tests also exercise failure preservation, concurrent stores, and a local mock endpoint for both supported protocols. They verify that catalog operations and compilation make no connections, then the explicit send performs one POST with the selected URL, API key, model, and output limit.

## CI builds and caches

Frontend checks run in the official Playwright container, which already includes
the browsers, fonts, and system libraries. When updating Playwright in
`package-lock.json`, update the `frontend` job's `playwright` matrix version in
`.github/workflows/ci.yml` too; CI checks that they match before installing npm
dependencies.

Frontend checks, Rust checks, and the Windows portable build run in parallel.
Windows artifacts are available as soon as that build finishes, even if another
check is still running or fails. Check the complete workflow result before
distributing an artifact; this workflow does not publish a release.

Rust dependency caches are separate for Linux checks and Windows release builds
and include the compiler, build environment, and Cargo manifests/lockfile in their
keys. Completed dependency builds can be saved even if a later check fails. CI
omits debug symbols for Linux checks to reduce compilation and cache size; Windows
still uses the normal release profile. A first run after changing the toolchain
or cache configuration can be cold, and GitHub may evict caches between infrequent
runs. Cargo commands use `--locked` to prevent implicit dependency updates.
