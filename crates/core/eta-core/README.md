# eta-core

The single-agent engine of the eta agent SDK.

Owns the `Agent` state machine, its channel-based input/output interface, the
linear turn loop (`drive_loop`), and the trait contracts the rest of the stack
plugs into: `Tool`, `SessionStorage`, `MemoryStore`, `SkillStore`, `Provider`,
and the cancellation token.

Goal self-continuation, loop (turn-external triggers), self-management, and
the builtin state tools (`ask_user` / `update_state` / `check_state` /
`list_state`) all live here.

Completely unaware of multi-agent: one agent owns one session. Side-effect
free — no filesystem, no network, no process spawning. Anything that touches
the outside world is a trait here, implemented in an `eta-*` adapter.
