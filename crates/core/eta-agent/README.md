# eta-agent

Multi-agent layer on top of `eta-core`.

Master/slave orchestration: the master agent is the single user-facing
interface; it picks (or creates) sub-agents by their `skill`/`memory`, assigns
kanban tasks, and talks to them via `SendToAgent`. Agent creation, update,
listing, and messaging are all `Tool` impls over recursive `eta-core::Agent`s.

The kanban board (task decomposition, `deps`, cascade pause/resume) and the
per-agent registry (`id`/`name` index into `MemoryStore`/`SkillStore`) live
here.
