# Overview

eta is a workbench for one person to direct multiple agents. The server is **a single Bun process** (`apps/eta`, hereinafter the main node or host): it hosts the Web app, product data, model credentials, and the entry point to the memory sidecar. A slimmed-down daemon (`apps/daemon`) can also run on other machines so sessions run there.

```
Browser (apps/web)
   │  One WebSocket: /ws (pipe protocol)          HTTP: static pages, /up, /version, /preview, /share
   ▼
Main node  apps/eta                              ← the only process; SQLite + files in one data directory
   ├─ Upstream floor  packages/eta-server: sessions, providers, settings, personas
   ├─ Product plugins  agents machines projects conversations inbox usage tasks artifacts routines [memory] [llm]
   ├─ LLM gateway  apps/eta/src/llm: CLIProxyAPI child process (@cpajs/cpa) with accounts, directories, and quotas (subscription accounts, Gemini key)
   ├─ Web reading    apps/eta/src/web: web_fetch / web_search, calls the sex library in-process; the managed SearXNG is a child process (see [Web reading and search](web.md))
   ├─ Local sessions  harness (packages/eta-core, eta-harness…) runs directly in-process
   │
   ├──── /machines/connect (WSS, daemon dials in)──▶ eta-daemon (other machines: sessions only)
   └──── HTTP (loopback)────────────────────────▶ memory sidecar apps/memory (Python + PostgreSQL/pgvector, optional)
```

## Processes

| Processes      | Location      | Purpose                                                                                                                          |
| -------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| host           | `apps/eta`    | The only required process. `bun apps/eta/src/main.ts`; for development, `bun run dev`                                                                 |
| web dev server | `apps/web`    | Only needed in development (vite proxies `/ws` to host). In production, host serves the built static pages directly (included in the packaged host; `--web-dir` can specify a different directory) |
| eta-daemon     | `apps/daemon` | Optional, one per additional machine. A single file produced by `bun build --compile`, without Web, database, product plugins, or model configuration                                 |
| Memory sidecar | `apps/memory` | Optional. Python (mem0 + fastembed), its own PostgreSQL (pgvector). Without it, host does not mount memory and the UI hides the memory page                         |

There are no other services: no control plane, message queue, container orchestration, or primary database. The LLM gateway is not a standalone service: CLIProxyAPI is a child process started and supervised by host, and exits with host (see [LLM gateway](llm-gateway.md)). SearXNG for search is the same: when no external address is provided, it is a child process started by host on the first search and exits with host (see [Web reading and search](web.md)).

## Code layout

```text
apps/
  eta/        host: entry main.ts, host.ts (assembly), product.ts (product plugins), access.ts (access control),
              db.ts + migrations/ (SQLite), plus agents, machines, projects, conversations, inbox, usage,
              memory, tasks, artifacts, routines, plugins, and web, one directory each
  daemon/     eta-daemon：setup / run / install-service
  web/        React UI, reads and writes over WebSocket
  memory/     Python sidecar
packages/
  eta-core, eta-harness, eta-compaction, eta-execution(-node), eta-storage-jsonl   kernel and session runtime
  eta-server, eta-plugin-sdk     upstream server floor: WebSocket pipeline, registry, state push, sessions, and other bundled plugins
  eta-ssh, eta-plugin-ssh, eta-plugin-git   execution environment over SSH and git plugins
  eta-plugin-akhook   declarative rules (akhook configuration) and streaming rules, see [akhook](akhook.md)
  eta-mcp             MCP library: proxy tools, lazy connections, metadata cache, direct tools, OAuth, see [MCP](mcp.md)
  client-wire-proto, client-contracts   wire frames and product target types (shared by Web and host)
deploy/       Dockerfile、memory.Dockerfile、compose.yaml
```

`packages/eta-*` comes from upstream eta-old (migrated via subtree and converted to this repository's format and lint). host runs these packages directly from source; no prior build is needed.

## Layering

1. **Floor** (`@eta/server`'s `assembleServer`): WebSocket pipeline, target registry, state push, session manager, model and provider configuration, persona. It knows no product concepts; see [wire protocol](wire-protocol.md).
2. **Product** (`apps/eta`): each feature is a cordis plugin that registers its own target and action with the floor; data lives in SQLite. Startup order is to build the product first (its hook is an option of the floor), then build the floor, and finally mount the plugins (`product.ts`'s `mount`); serving starts only once everything is in place.
3. **UI** (`apps/web`): one connection, one store of sections keyed by target, and one set of hooks per target. No REST. Plugins not present in `hello.mounted` have their entry points hidden.

## Why it is this way

- Sessions (the upstream harness's session) are stored as files, which is already mature persistence; the product only adds a SQLite bookkeeping layer on top (who, which conversation, who is waiting on whom) and does not copy session content.
- Every change is "the table changed, notify the target"; a section's revision is the hash of the content read, so it cannot become inconsistent with the data, and there are no version numbers to maintain.
- A remote machine is not a separate system; it is the same session mechanism running elsewhere. The host mirrors its state onto its own wire, so the browser does not need to know which machine the session is on.
