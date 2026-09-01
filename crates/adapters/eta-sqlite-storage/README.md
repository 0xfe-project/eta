# eta-sqlite-storage

SQLite-backed storage for the eta agent SDK — the single storage backend for
all session-side state: session-state, context, compaction, kanban, and commits.

Implements the `eta-core` `SessionStorage` seam trait. (`MemoryStore` /
`SkillStore` are per-agent and live in `eta-agent`, not here.)
