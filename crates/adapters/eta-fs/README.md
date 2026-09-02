# eta-fs

Filesystem layout + a `notify`-based hot-reload watcher for eta's resource
directories (`~/.eta`, `.agents/skills`, mcp.json, persona, …).

Two concerns, kept separate so `eta-core` stays zero-IO:

- `paths` — where things live on disk (`~/.eta/...`, per-session / per-agent
  sqlite paths). Pure path arithmetic, no IO.
- `watch` — a `notify` watcher that emits change events on a channel, so the
  adapter layer can rescan + hot-reload resources.

Layout (overridable via `ETA_HOME` for tests):

```
~/.eta/
  persona/            *.persona.md
  skills/             (same rules as .agents/skills)
  mcp.json            user-registered MCP servers
  sessions/<uuid>.sqlite
  agents/<NAME>.sqlite
```
