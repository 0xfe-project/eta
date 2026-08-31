# eta-llm

Model & inference contracts, with zero HTTP.

Defines the pure types (`Model`, `Message`, `Tool`, `Content`) and the
`Provider` trait that turns a prompt into a stream of `StreamEvent`s.

Concrete transports (Anthropic, OpenAI, OpenRouter, local OpenAI-compatible
servers) live in `eta-provider-*` adapters and are never referenced here.
