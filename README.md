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

```bash
npm install
cargo install tauri-cli --version "^2"
cargo tauri dev
```

For a frontend-only browser preview:

```bash
npm run dev
```

The browser preview uses local demo data and simulates streaming. File import and real provider requests are desktop-only.

The browser starts with an empty provider catalog and persists it in the `cerachat.provider-catalog.v1` localStorage entry. Its versioned envelope separates public `settings` from provider-keyed `secrets` and commits both in one storage operation. Invalid data fails locally without being rewritten. To start over explicitly, remove that entry using browser developer tools and reload.

## Verification

```bash
npm run lint
npm run build
npx playwright install chromium
npm run test:e2e
cd src-tauri
cargo fmt --all -- --check
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
```

To use an installed Chromium browser, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when running `npm run test:e2e`. UI tests cover local persistence, grouped search, selection restoration, strict errors, disabled requests, and absence of provider traffic during configuration.

Rust tests also exercise failure preservation, concurrent stores, and a local mock endpoint for both supported protocols. They verify that catalog operations and compilation make no connections, then the explicit send performs one POST with the selected URL, API key, model, and output limit.
