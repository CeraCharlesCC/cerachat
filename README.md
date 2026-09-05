# CeraChat

CeraChat is a local-first Tauri 2 chat client built around one rule: the only model network access is the request the user explicitly compiles, inspects, and sends.

## v1 architecture

- **Desktop:** Tauri 2 + Rust
- **UI:** React + TypeScript + Vite
- **Storage:** SQLite with foreign keys, WAL, and cascade deletes
- **Provider:** OpenAI-compatible Chat Completions streaming over SSE
- **Context:** local TXT/MD/JSON/LOG/CSV text plus locally expanded ZIP entries
- **Blob storage:** SHA-256 content addressing with zstd compression

There are deliberately no tools, function calling, MCP, RAG, web search, model discovery, capability probes, auto-summarization, auto-title model calls, telemetry, cloud sync, or provider fallback loops.

## Request flow

1. Choose a conversation branch and history policy.
2. Add local context sources and enable whole-file or line-range slices.
3. Choose raw/labeled wrapping, ordering, and insertion point per slice.
4. Open **Request** to inspect the exact JSON, token estimate, compiled audit text, and SHA-256.
5. **Send** performs one HTTP POST. Redirects and automatic reqwest retries are disabled.
6. The exact request JSON, compiled prompt, SHA-256, and referenced context blob hashes are persisted for reproducibility.

Provider settings are saved locally without making a network request. The first Send is the first provider access.

## Portable data

By default the desktop executable writes under a sibling `data/` directory:

```text
CeraChat/
├─ CeraChat.exe
└─ data/
   ├─ chat.sqlite3
   ├─ settings.json
   ├─ secrets.json
   └─ logs/
```

Set `CERACHAT_DATA_DIR` to override the directory during development. v1 supports the explicit **Plain portable configuration** API-key mode; the Windows DPAPI choice is visible as planned but disabled rather than silently falling back.

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
