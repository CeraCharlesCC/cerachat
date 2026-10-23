# CeraChat

CeraChat is a local-first desktop chat client for deliberate, auditable use of OpenAI-compatible model APIs. The user decides when a provider is contacted and what context is included in each request.

## Design principles

- **Explicit network boundary.** Provider configuration, context import, conversation editing, and request preview are local operations. Model requests happen only on explicit send or regeneration; there is no background discovery, provider fallback, or automatic model call.
- **Inspectable and reproducible requests.** Users can inspect the compiled request before sending. Sent requests and their referenced context are preserved so later edits cannot rewrite what was sent.
- **Chosen, not inferred, context.** Users control which local text and ranges are included, in what order and format. There is no automatic retrieval, summarization, or hidden context injection.
- **Non-destructive conversation history.** Editing creates alternative branches rather than overwriting messages or past request records.
- **Portable, user-owned data.** Conversations, context, and settings stay on local disk; there is no cloud sync or telemetry. Portable API-key storage is currently plaintext, so protect the data directory.
- **Deliberately narrow scope.** CeraChat is a chat client, not an agent runtime: no tool/function calling, MCP integration, or web search.

## Workflow

Configure a provider and its models, select a conversation branch and local context, inspect the request preview, then explicitly send. The browser preview (`npm run dev`) uses simulated responses; file import and real provider requests require the desktop app.

Each chat has its own Source library and attachment list, shared across all of that chat's branches. Switching to another chat restores that chat's context; a new chat starts empty. Use **Add from another chat** to search by chat or source name and explicitly reuse a source. The added source has independent attachment settings and remains available if the original source or chat is deleted. Automatic inclusion follows **New attachment options**.

Sources from older versions' shared library remain available under **Previous shared library** in the same picker. They are preserved without being automatically included in any chat; add the sources you want to each chat explicitly. Past request snapshots are unchanged.

Request parameters belong to each model. In **Provider settings**, select a model to edit **Temperature**, **Top P**, **Reasoning effort**, **Verbosity**, **Service tier**, **Store response**, and **Raw JSON overrides**. Each optional parameter has an On/Off switch: Off omits it from the request; `none` reasoning effort and `false` storage are explicit values. Reasoning summary is available for Responses; frequency/presence penalties and seed are available for Chat Completions. Controls edit the same JSON as the raw editor and preserve unrelated nested fields. Model names do not determine parameter support; enable only settings accepted by that model. [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) uses `reasoning_effort`, `verbosity`, and `max_completion_tokens`; [Responses](https://developers.openai.com/api/reference/python/resources/responses/methods/create) uses `reasoning.effort`, `text.verbosity`, and `max_output_tokens`. Existing version 1 provider parameters are inherited by all of that provider's saved models when read; the next explicit settings save writes version 2. Reads do not modify settings or secrets.

Provider reasoning appears in a collapsible panel above the answer and is saved with the response. Summaries are labeled separately from provider reasoning text; the latter may itself be summarized by the provider. Reported reasoning token counts are shown when available. Each visible block has an **Include next** checkbox, unchecked by default. Checked blocks are saved locally and added before that assistant answer as labeled text in later requests, only when the message belongs to the selected history and is included. Uncheck a block to remove it from subsequent requests; the request preview and token estimate reflect the selection. This is manual reuse of visible text, not native replay of opaque reasoning state: [OpenAI Responses native replay](https://developers.openai.com/api/docs/guides/conversation-state) requires original output items, which CeraChat does not retain. Protected reasoning cannot be displayed or included. Editing an answer clears its reasoning and block selections on the new branch. The browser demo streams sample reasoning so these controls can be tried without a provider request.

For supported [OpenAI Responses models](https://developers.openai.com/api/docs/guides/reasoning), open provider settings, select the model, enable **Reasoning summary**, enter `auto`, and **Save model**. Other providers may need their own **Raw JSON overrides**: [OpenRouter](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) supports `{"reasoning":{"enabled":true,"exclude":false}}`; [Gemini's OpenAI endpoint](https://ai.google.dev/gemini-api/docs/openai) supports `{"extra_body":{"google":{"thinking_config":{"include_thoughts":true}}}}`. For Chat Completions endpoints that support usage streaming, `{"stream_options":{"include_usage":true}}` requests token usage. Merge these with existing overrides as appropriate; provider and model support varies. Configuration and preview remain local operations.

## Development

Use Node.js 22 and Rust via rustup (the Rust toolchain is pinned in `rust-toolchain.toml`). For desktop development:

```bash
npm ci
cargo install tauri-cli --version "^2"
cargo tauri dev
```

For frontend checks, run `npm run lint`, `npm run build`, and `npm run test:e2e` (install Playwright's Chromium first if needed).

`.github/workflows/ci.yml` is the source of truth for CI checks and Windows portable builds. The Windows executable is distributed as a workflow artifact, not an automatic release; check the full workflow result before sharing it.

Implementation details belong in the code and configuration that define them, not in parallel README descriptions of schemas, UI states, or build internals.
