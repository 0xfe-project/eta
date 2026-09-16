# Model provider configuration

Open Settings → Model providers. Kimi for Coding uses the OpenAI Chat Completions
endpoint at `https://api.kimi.com/coding/v1`. Enter a Kimi Code API key, connect to
discover models, then save. Custom OpenAI-compatible endpoints can discover models
or use manually entered model definitions, including explicit capability overrides.
A custom provider also picks its call protocol: **Chat Completions**
(`/chat/completions`) or the **Responses API** (`/responses`). Choose the default
model on the provider list. Default thinking preferences belong to each model;
supported levels and provider defaults come from discovery.

## Persistence and compatibility

Providers remain in `~/.eta/config.json`. Existing providers without `kind` are
interpreted as `openai-compatible`, and models without reasoning metadata retain
the old non-reasoning default. `kind: "kimi-coding"` selects Kimi's endpoint and
compatibility options. `kind: "openai-responses"` keeps the custom endpoint but
sends the Responses protocol instead; both custom kinds leave the API key
optional. Optional model fields are `reasoning`, `thinkingMode`,
`reasoningEfforts`, `providerDefaultEffort`, `defaultThinking`, and `overrides`.
Overrides belong to custom providers and survive discovery refreshes. Unknown
capabilities are not treated as unsupported, nor are effort controls invented.

Settings writes preserve unrelated providers and top-level config fields. They use
an optimistic revision, serialize concurrent saves, and atomically replace the
file with permissions `0600`. Invalid existing JSON is reported instead of being
silently replaced. API responses never include saved API keys. An omitted key
keeps the saved one; `null` explicitly clears it. Editing an endpoint requires key
re-entry before a saved credential can be sent to the new host.

A provider may also declare `headers`: extra request headers sent both with model
calls and with model discovery, so an endpoint that gates on them does not accept
prompts while rejecting refreshes. A `null` value means “do not send this header”,
which also drops one we would otherwise add — for example a saved `Authorization`
when the endpoint wants a different scheme. Names are HTTP tokens compared
case-insensitively with the last occurrence winning, up to 32 entries, and values
may not contain line breaks. Header values are returned by `GET /api/providers`,
unlike keys, so they are visible configuration rather than secrets.

New sessions use the configured model and its default thinking preference. Saving
refreshes client model menus and idle agent registries without recreating sessions.
Active runs retain their registry until `run_end`. Existing sessions keep their
selected model; switching models is allowed while idle and applies the target
model's default thinking preference. Removing a model currently used by an open
session is rejected. Goal evaluation, memory extraction and BTW use the same
provider registry as the main conversation.

Persona and compaction defaults stay in the existing session `settings.json`;
client theme/language/sidebar preferences retain their existing stores. Selecting
a default model through the new API clears the old global model/thinking defaults.
The SQLite schema and existing session journals do not change.

## HTTP API

All endpoints below return JSON and `Cache-Control: no-store`:

- `GET /api/providers`: redacted providers, default model and config revision.
- `POST /api/providers/discover`: `{ provider }`; returns `{ models }`, without
  saving. Kimi reads `context_length`, reasoning/input flags and nested
  `think_efforts` metadata from `GET /models` using Bearer authentication.
- `POST /api/providers`: `{ revision, provider }`; saves one provider. `provider`
  contains `id`, `kind`, `baseUrl`, `models`, and optional `name` / `apiKey` /
  `headers`.
- `POST /api/providers/default`: `{ revision, defaultModel }`; a `provider:model`
  identity selects the default; `null` follows the first configured model.
- `DELETE /api/providers/:id`: `{ revision }`; removes an unused provider.

Mutations require `Content-Type: application/json`. Config conflicts return 409;
validation and upstream errors return stable error codes, localized by the client.
Discovery failures retain the saved catalog and the current form draft. Discovery
has a deadline, a response-size limit and does not follow redirects with keys.

Settings APIs accept their own origin and the loopback Vite development origins
on ports 5173/5174. Desktop opaque-origin requests must carry the shell's preload
credential in `Authorization`. Unrelated browser origins are rejected, including
preflight requests. These checks are scoped to provider settings, not a replacement
for a server-wide authentication system.

## Verification

`bun test test/providers.test.ts` (from this package) exercises discovery, key
redaction, file permissions, revision conflicts, malformed config handling,
refresh preservation and Chat Completions requests through a local HTTP fixture,
plus a Responses-provider round trip that asserts the request lands on
`/responses` with `input` items. Client tests cover model discovery, per-model
effort selection, custom model editing, the protocol choice, save errors and
unsaved modal drafts. Real Kimi account access still requires a user-supplied key;
the automated tests never contact Kimi.

## Responses protocol

`kind: "openai-responses"` selects pi's `openai-responses` transport for the same
provider record shape: base URL, key, headers and model list are configured
exactly as for a custom Chat Completions provider. The protocol choice belongs to
the provider, not to a single model, because gateways commonly route by path.

On the wire the two differ in more than the URL:

- The request carries `input` items rather than chat `messages`, and names the
  output allowance `max_output_tokens` instead of `max_tokens`.
- Thinking levels map through the same `thinkingLevelMap` to `reasoning.effort`.
- Streaming is a sequence of `response.*` events ending in `response.completed`;
  there is no `[DONE]` sentinel.

Chat Completions compatibility flags are not applied to this transport. Flags such
as `maxTokensField: "max_tokens"`, `supportsDeveloperRole: false`,
`requiresReasoningContentOnAssistantMessages` and DeepSeek's `thinkingFormat`
describe Chat Completions request fields that this protocol does not have, so the
Responses defaults stand: `developer` roles, `store: false` and the Responses
cache parameters. Keep that in mind when adding a new preset kind — compatibility
has to be chosen per API, not per provider.

Two caveats are worth knowing before making such a model the default:

- Model discovery always reads `{baseUrl}/models`, which the provider may answer
  from a group other than the one that serves the chosen protocol. A gateway can
  list models that only answer on `/chat/completions` while a model that only
  answers on `/responses` is absent from the list. Add those models manually.
- Capability metadata (context window, reasoning levels, vision) comes from the
  same listing, so a manually added model starts with whatever you type into its
  overrides.

## DeepSeek

The DeepSeek preset uses `https://api.deepseek.com` and reads the actual available
IDs from `/models`. That endpoint does not publish reasoning capabilities, so
`provider-presets.ts` supplies a documented fallback for `deepseek-flash`,
`deepseek-v4-pro`, and the retained `deepseek-v4-flash` /
`deepseek-v4-flash-vision-exp` aliases. Supported levels are off, low, high and max,
with high as the provider default. API-provided metadata takes precedence when
present. Other IDs remain unknown; they are not assigned speculative effort levels.

DeepSeek requests use `thinking.type` for enabled/disabled and `reasoning_effort`
for low/high/max, and preserve reasoning content when replaying tool conversations.
Legacy effort aliases map to the documented canonical values (minimal → low,
medium/xhigh → high). The preset's output allowance is 128K tokens, within the
published limit, so max-effort requests are not constrained by the generic 8K default.

Sources verified on 2026-09-15: [models](https://api-docs.deepseek.com/quick_start/pricing/),
[thinking](https://api-docs.deepseek.com/guides/thinking_mode/), and
[request parameters](https://api-docs.deepseek.com/api/create-chat-completion/).
Existing custom providers are not automatically rewritten into the new preset.
