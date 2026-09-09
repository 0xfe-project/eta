# eta-agent


## Embedding

The supported way to embed the agent is `eta-core-controller`. Adapters
(providers, sqlite, fs, MCP) live behind it; frontends (the dev TUI in
`bin/eta-core-dev-tui`, the serializing skeleton in `bin/eta-core-web`)
depend only on it + `eta-core` event types. See REFACTOR.md for the
post-refactor architecture and remaining follow-ups.
