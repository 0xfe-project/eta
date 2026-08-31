# eta-agent

The pure heart of the eta agent SDK.

Owns the `Agent` state machine, its channel-based input/output interface, the
linear turn loop, and the trait contracts the rest of the stack plugs into:
`AgentTool`, `ContextPlugin`, `SessionStorage`, `Spawner`, and the cancellation
token.

Side-effect free: no filesystem, no network, no process spawning. Anything that touches the outside world is a trait here and an
implementation in an `eta-*` adapter, injected by the embedder.
