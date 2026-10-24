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

In the desktop app, configure a provider and model, choose a chat branch, attach only the local context and images you want to share, inspect the request preview, then send. You can revisit or branch earlier messages without changing the request records associated with them. The browser development preview simulates responses; real provider requests and file import require the desktop app.

**Check the actual provider and model documentation before enabling optional capabilities.** Image input, custom parameters, and reasoning replay are not uniformly supported by OpenAI-compatible APIs. The request preview exposes the data selected for transmission, including images; token estimates cover text rather than image costs. Edited or replayed plaintext reasoning is an experiment, not a reconstruction of a provider's signed, encrypted, or otherwise protected reasoning state. Even a preserved request cannot guarantee an identical future model response.

**Protect the portable data directory.** It can contain conversation history, imported content, image data, and complete request payloads. Provider API keys are currently stored there in plaintext. Do not place this directory on an untrusted or publicly shared drive.

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

## Where behavior is defined

Treat implementation and tests as the source of truth for behavior, not this README. Request compilation and API payload construction live in [`src-tauri/src/context/compiler.rs`](src-tauri/src/context/compiler.rs); provider transport lives in [`src-tauri/src/providers/`](src-tauri/src/providers/). Local storage and migrations live in [`src-tauri/src/db/`](src-tauri/src/db/) and [`src-tauri/src/portable/`](src-tauri/src/portable/). The frontend and browser simulator live in [`src/`](src/). [Rust tests](src-tauri/src/) and [end-to-end tests](tests/) capture the observable contracts.

When changing a limit, setting, API field, UI control, or data format, change its defining code and tests. Update documentation when the **purpose, trust boundary, design trade-off, or user-facing risk** changes; do not maintain parallel tables of implementation details here.
