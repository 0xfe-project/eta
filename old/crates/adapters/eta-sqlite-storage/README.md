# eta-sqlite-storage

SQLite-backed storage for the eta agent SDK — the durable backend for all
session-side state.

One SQLite file per session (`~/.eta/sessions/<uuid>.sqlite`) and one per agent
(`~/.eta/agents/<NAME>.sqlite`).

Implements the `eta-core` `SessionStorage` seam trait:

- `entries` — append-only `SessionEntry` (id autoincrement).
- `kv` — session KV (`set/get/delete/list_state_keys`).
- `commits` / `branches` — git-like time travel (snapshot = full `SessionState`).
- `entries_fts` — BM25 full-text search (FTS5).
- `list_sessions` — enumerates `*.sqlite` in a sessions directory.
