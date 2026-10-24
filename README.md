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

Attach images using the composer button, clipboard paste, or drag and drop. In **Provider settings**, enable **Image input** for each service/model that accepts inline images; existing and new models default to Off. This applies to compatible services such as [OpenRouter](https://openrouter.ai/blog/tutorials/send-image-to-llm/), [NVIDIA NIM](https://docs.nvidia.com/nim/large-language-models/_2.0.13/2.0.13/advanced-use-cases/multimodal-input.html), and [NanoGPT](https://docs.nano-gpt.com/api-reference/endpoint/chat-completion), as well as OpenAI. Check the actual endpoint and model's capabilities; a service name or model ID does not establish image support. The client accepts PNG, JPEG and WebP, up to four images of 5 MiB each per message; services may impose stricter format, count or size limits. Images stay local until explicit send and remain attached when editing or regenerating a message. If you switch to a model with image input Off, remove draft images and exclude image messages via **Include next** or **No history** before sending. Provider errors are shown without silently dropping images or retrying. Request previews include image bytes, while token estimates cover text only.

Each chat has its own Source library and attachment list, shared across all of that chat's branches. Switching to another chat restores that chat's context; a new chat starts empty. Use **Add from another chat** to search by chat or source name and explicitly reuse a source. The added source has independent attachment settings and remains available if the original source or chat is deleted. Automatic inclusion follows **New attachment options**.

Sources from older versions' shared library remain available under **Previous shared library** in the same picker. They are preserved without being automatically included in any chat; add the sources you want to each chat explicitly. Past request snapshots are unchanged.

Request parameters belong to each model. In **Provider settings**, select a model to edit **Temperature**, **Top P**, **Reasoning effort**, **Verbosity**, **Service tier**, **Store response**, and **Raw JSON overrides**. Each optional parameter has an On/Off switch: Off omits it from the request; `none` reasoning effort and `false` storage are explicit values. Reasoning summary is available for Responses; frequency/presence penalties and seed are available for Chat Completions. Controls edit the same JSON as the raw editor and preserve unrelated nested fields. Model names do not determine parameter support; enable only settings accepted by that model. [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) uses `reasoning_effort`, `verbosity`, and `max_completion_tokens`; [Responses](https://developers.openai.com/api/reference/python/resources/responses/methods/create) uses `reasoning.effort`, `text.verbosity`, and `max_output_tokens`. Existing version 1 provider parameters are inherited by all of that provider's saved models when read; the next explicit settings save writes version 2. Reads do not modify settings or secrets.

Provider reasoning appears in a collapsible panel above the answer and is saved separately. Raw `reasoning_content` streams (DeepSeek, Kimi, GLM and compatible services) and Responses `reasoning_text` are included in subsequent history by default; summaries remain opt-in. Existing saved block selections are retained. **Include next** and the whole-message/history filters still apply. Raw chunks are concatenated verbatim, without labels or inserted separators. **Edit reasoning** opens the message editor: add, edit, or remove blocks, change their selection, and save a new branch, including reasoning-only messages. Original messages, descendants, and request snapshots remain intact. Edited branches clear provider token counts and protected-state metadata and are marked edited.

The editor offers three replay modes, independently of model names:

- **Native raw** (default): selected raw text is sent as assistant `reasoning_content` in Chat Completions, or a plaintext `reasoning` item with `content: [{type: "reasoning_text", text: …}]` in compatible Responses APIs. This is for endpoints that accept raw reasoning. Selected summaries remain labeled assistant notes. It does not reconstruct encrypted or signed reasoning.
- **Interleaved mock**: keeps raw reasoning in its native field and appends a synthetic `cerachat_intervention` call. The immediately following selected user text (including current input and its workspace context) becomes the paired tool result, once, so it continues the same tool-use turn. Every call has a deterministic matching ID and a result; when no user follows, the result is `Continue.`. A tool definition is supplied with `tool_choice: "none"`; no external tool executes. This experimental mode requires raw text without summaries/protected state and a tool-capable endpoint. Image interventions produce a local error; use Native raw for images. History filtering removes whole mock pairs, never half a pair.
- **Assistant notes**: text compatibility for services without raw reasoning input; notes appear in assistant content and may be interpreted as ordinary conversation text. This is an explicit fallback, never a silent replacement for native replay.

Provider preservation rules differ; sending the field alone is not always enough:

| Provider | Preservation requirement |
| --- | --- |
| [DeepSeek v4](https://api-docs.deepseek.com/guides/thinking_mode/) | Requests with `tools` require the historical `reasoning_content`, including assistant turns without calls. Without `tools`, the service ignores prior reasoning. Interleaved mock supplies a tool definition and paired intervention. [DeepSeek Responses](https://api-docs.deepseek.com/guides/responses_api/) accepts plaintext reasoning `content`, not summaries/encrypted state. |
| [Kimi K3](https://www.kimi.com/en/blog/kimi-k3#limitations) | Trained with preserved thinking history; missing historical thinking or switching into K3 midway can destabilize generation. Keep the full history and raw block selections for normal preservation. |
| [GLM](https://docs.z.ai/guides/capabilities/thinking-mode) | Standard API: set `{"thinking":{"type":"enabled","clear_thinking":false}}` in model Raw JSON overrides. Coding Plan enables preservation by default. Normal preservation requires complete, unmodified, ordered reasoning. |
| [OpenRouter](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) | Raw string reasoning can use `reasoning_content` (alias of `reasoning`). Signed, encrypted, or summarized `reasoning_details` require original complete blocks; CeraChat does not replay those as raw state. |
| [Qwen](https://docs.qwencloud.com/developer-guides/text-generation/thinking) | Depending on model/endpoint, `preserve_thinking: true` is required. Server chat-template settings also matter for local inference. |

Raw edits, partial block selection, and synthetic tool turns are experiments, not guaranteed native continuation: providers may ignore changes or produce worse results. Full unmodified replay is the baseline for preservation. Anthropic/Gemini signatures and OpenAI encrypted reasoning are separate formats; CeraChat does not fabricate them. Request preview shows the actual native fields and mock call/result pair; the audit view labels those fields only for inspection. No live-provider quality claim is implied by local fixture tests.

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
