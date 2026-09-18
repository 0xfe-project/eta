# Provider architecture and configuration

## Configure a provider

Open **Settings → Model providers**, choose a built-in provider or a custom
OpenAI-compatible endpoint, connect to load its models, and save the selection.
The provider list also controls the default model. Each model stores its own
default thinking preference, while discovery and the checked-in catalog provide
its supported levels and provider default.

Built-in providers supply their official endpoint, authentication method,
discovery policy, runtime protocol and curated model set. Custom providers accept
an endpoint, optional API key, headers and either of these protocols:

- **Chat Completions** sends `messages` to `/chat/completions`.
- **Responses API** sends `input` items to `/responses`.

A manually entered custom model can carry explicit capability overrides. This
supports gateways whose model-list endpoint and inference routes publish different
sets of models.

## Unified provider definition

`src/provider-model-catalog.json` is the canonical provider definition catalog.
Every provider kind declares these parts together:

- `match`: provider kinds and official base URLs.
- `auth`: API-key or Codex OAuth adapter.
- `discovery`: `openai-models` or checked-in `catalog` adapter.
- `runtime`: `openai-chat`, `openai-responses` or `codex` adapter.
- `restrictToListedModels`: curated allowlist policy.
- `models`: model IDs and Eta capability corrections.

`src/provider-model-catalog.ts` validates the complete structure at startup. It
also resolves provider definitions, merges model metadata and applies the same
catalog while loading configuration, serving settings, discovering models and
constructing the runtime registry.

Model metadata follows one ordered merge:

1. pi-ai generated model metadata supplies the base definition.
2. Eta's exact provider/model entry applies reviewed corrections.
3. Explicit `/models` metadata refreshes fields published by the provider.
4. Custom-provider overrides apply the user's explicit corrections.

Built-in providers expose the model IDs in their catalog entry. A custom provider
receives official capabilities when its normalized base URL exactly matches an
official endpoint; other custom models retain their own metadata.

## Discovery and runtime adapters

Provider discovery runs through an adapter registry:

- `openai-models` requests `GET {baseUrl}/models`, applies authentication and
  configured headers, reads optional capability metadata, and merges the catalog.
- `catalog` returns the checked-in model set after its auth adapter succeeds.

Runtime construction uses a parallel registry in `src/provider-runtime.ts`:

- `openai-chat` builds one shared Chat Completions provider.
- `openai-responses` builds a Responses API provider.
- `codex` builds the pi-ai Codex provider with Eta's selected catalog.

Kimi, DeepSeek and both GLM regions use the same `openai-chat` factory. Their JSON
runtime definitions carry the exact thinking format, role support, store support,
max-token field, reasoning replay and tool-stream behavior required by each API.
The Harness consequently receives one model interface and one streaming event
contract across all three runtime adapters.

For a new provider that uses an existing protocol and discovery format, the
backend work is a provider definition and its model entries. A built-in preset
also adds its shared Core preset, localized UI description and logo. A genuinely
new wire protocol or model-list shape adds one adapter and then becomes reusable
by later providers.

## Model capabilities and context safety

`model.input` is the single modality contract. `text` enables text input and
`image` enables image blocks. The settings UI, composer and request boundary all
consume this same value.

The composer accepts new images for image-capable models. At the request boundary,
a text-only model receives a deterministic numbered marker for every historical
image, including its MIME type. For example, separate images become attachment
`#1` and attachment `#2`, preserving their identity and order in textual
references. The conversion operates on the outgoing request copy; the session
journal retains the original image blocks, so switching back to an image-capable
model sends the original images again.

Reasoning capability uses `reasoning`, `thinkingMode`, `reasoningEfforts` and
`providerDefaultEffort`. `defaultThinking` remains the user's per-model choice.
The runtime maps Eta's canonical levels onto each provider's declared thinking
format.

## Connection protocols

Chat Completions providers share request construction, authentication, headers,
message conversion and streaming parsing. Their catalog runtime policy specializes
wire-level details:

- Standard reasoning uses `reasoning_effort`.
- DeepSeek combines `thinking.type` with `reasoning_effort` and replays
  `reasoning_content` through tool conversations.
- GLM combines `thinking.type` with `reasoning_effort` and enables ZAI tool-stream
  handling.

Responses providers use `input`, `max_output_tokens`, `reasoning.effort` and
`response.*` streaming events. The dedicated adapter gives this protocol its own
request fields while preserving the same Eta model and Harness interfaces.

Codex uses its OAuth credential flow and `openai-codex-responses` transport. The
runtime registry presents it through the same configured-model registry used by
conversation, goal evaluation, memory extraction and BTW requests.

## Provider profiles

### Codex

- Kind: `openai-codex`
- Endpoint: `https://chatgpt.com/backend-api`
- Authentication: ChatGPT OAuth
- Discovery: checked-in catalog after login verification
- Runtime: Codex Responses transport

The JSON catalog contains the supported Codex model IDs, while pi-ai contributes
their generated capabilities and transport implementation.

### KFC(Kimi for Coding)

- Kind: `kimi-coding`
- Endpoint: `https://api.kimi.com/coding/v1`
- Authentication: bearer API key
- Discovery: OpenAI-compatible `/models` with Kimi capability metadata
- Runtime: shared Chat Completions factory
- v me 50

The curated set contains `kimi-for-coding`, `kimi-for-coding-highspeed`, `k3` and
`k3-256k`. Discovery refreshes display names, context windows, image support,
thinking mode, effort levels and provider defaults. Kimi's runtime profile uses
`max_tokens`, canonical reasoning effort and reasoning-content replay.

### DeepSeek

- Kind: `deepseek`
- Endpoint: `https://api.deepseek.com`
- Authentication: bearer API key
- Discovery: OpenAI-compatible `/models`
- Runtime: shared Chat Completions factory with DeepSeek thinking format

The curated set contains `deepseek-flash` and `deepseek-v4-pro`.
`deepseek-flash` accepts text and images; `deepseek-v4-pro` accepts text. Both
support off, low, high and max, with high as the provider default. Legacy Harness
levels map to the canonical provider values: minimal maps to low, while medium and
xhigh map to high. The catalog supplies a 1M context window and 128K output limit.

Sources verified on 2026-09-15:
[models](https://api-docs.deepseek.com/quick_start/pricing/),
[thinking](https://api-docs.deepseek.com/guides/thinking_mode/), and
[request parameters](https://api-docs.deepseek.com/api/create-chat-completion/).

### GLM Coding Plan

Eta provides two regional presets:

- `zai-coding-cn`: `https://open.bigmodel.cn/api/coding/paas/v4`
- `zai`: `https://api.z.ai/api/coding/paas/v4`

Both use bearer API keys, OpenAI-compatible discovery and the shared Chat
Completions runtime with ZAI compatibility. Their curated set contains `glm-5.3`
and `glm-5.3-flash`. `glm-5.3` accepts text, while `glm-5.3-flash` accepts text
and images. Both expose off, low, high and max; off maps to
`thinking: { type: "disabled" }` and enabled levels carry `reasoning_effort`.

### Custom OpenAI-compatible providers

- `openai-compatible` selects Chat Completions.
- `openai-responses` selects the Responses API.

Both support model discovery and manual model definitions. API keys are optional,
provider headers apply to discovery and inference, and unknown capabilities remain
available as explicit model overrides. Legacy configuration entries that omit
`kind` resolve to `openai-compatible` for compatibility.

## Persistence and live updates

Provider instances are stored in `~/.eta/config.json`. API responses expose a
redacted provider view while credentials remain in the local config file. An
omitted key keeps the saved value and `null` clears it. Endpoint edits request key
re-entry before the credential is used with the new host.

Settings writes use optimistic revisions, serialize concurrent updates and replace
the file atomically with permissions `0600`. Validation errors preserve the
existing file. Provider saves refresh client model menus and idle runtime
registries; active runs keep their current registry until `run_end`. Existing
sessions retain their selected model, and idle model switches apply the target
model's default thinking preference.

A provider may declare up to 32 additional HTTP headers. They apply to discovery
and inference, use case-insensitive names and accept `null` to suppress a transport
default such as `Authorization`. Header values are visible provider configuration;
API keys use the redacted credential path.

## HTTP API

All provider endpoints return JSON with `Cache-Control: no-store`:

- `GET /api/providers` returns redacted providers, default model, network settings
  and config revision.
- `POST /api/providers/discover` accepts `{ provider }` and returns `{ models }`.
- `POST /api/providers` accepts `{ revision, provider }` and saves one provider.
- `POST /api/providers/default` accepts `{ revision, defaultModel }`.
- `DELETE /api/providers/:id` accepts `{ revision }` and removes an available
  provider.

Mutations use `Content-Type: application/json`. Stable error codes describe config
revisions, validation and upstream status for client localization. Discovery has
a 15-second deadline, a 2 MiB response limit and redirect protection for
credential-bearing requests.

The server accepts its own origin and loopback Vite development origins on ports
5173 and 5174. Desktop opaque-origin requests authenticate with the shell preload
credential. These checks scope provider settings to trusted Eta clients.

## Verification

Server tests cover catalog validation, every built-in provider definition, auth
and discovery dispatch, curated model filtering, request payloads, reasoning
mappings, header handling, key redaction, atomic persistence, Responses transport
and Codex OAuth. Local HTTP fixtures exercise Kimi, DeepSeek and GLM runtime
behavior. Client tests cover connection, model selection, capability display,
custom providers, protocol choice and save flows.
