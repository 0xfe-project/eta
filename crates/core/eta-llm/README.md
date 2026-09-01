# eta-llm

Model & inference contracts, with zero HTTP.

Defines the pure types (`Model`, `Context`, `Usage`, `StopReason`) and the
`Provider` trait that turns a prompt into a stream of `Event`s. `Event` carries
`ToolCall { id, name, arguments }` and `End { usage, stop }`, and the stream's
`Item = Result<Event, ProviderError>` so mid-stream errors can be retried.

Content wire format (adapter follows, core does not enforce):

```json
{ "type": "text",        "text": "..." }
{ "type": "image_url",   "image_url": { "url": "url or base64 data url" } }
{ "type": "input_audio", "input_audio": { "data": "base64 data url", "format": "wav/mp3/..." } }
{ "type": "video_url",   "video_url": { "url": "..." } }
```

Concrete transports (Anthropic, OpenAI, OpenRouter, local OpenAI-compatible
servers) live in `eta-provider-*` adapters and are never referenced here.
