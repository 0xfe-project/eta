# Development

For working on eta itself: the layout, the tools, running it from a checkout. Installing a release is in
the [README](../README.md#install); running one is in [Self-hosting](self-hosting.md).

## Layout

```text
apps/
  eta/       host: one Bun process — WebSocket pipe, cordis plugins, SQLite (main node)
  daemon/    eta-daemon: a slim node on another machine, dials back to the main node, runs sessions only
  web/       React UI, reads and writes over that same WebSocket
  tui/       eta: terminal UI, a client of the host over that same WebSocket
packages/
  eta-*        kernel, harness, server floor, SSH and git plugins of upstream eta
  client-wire-proto, client-contracts   wire frames and product target types
docs/architecture/   design notes
```

Architecture notes:

- [Overview](architecture/overview.md): processes, layers, code layout
- [Wire protocol and targets](architecture/wire-protocol.md): WebSocket pipe, frames, targets and actions
- [Product model](architecture/product-model.md): agents, machines, projects, conversations, the lead agent, wake-up rules
- [Data](architecture/data.md): SQLite and migrations, session files, data directory layout
- [Phone app](architecture/mobile.md): the Native Shell client, connecting, scanning, packaging
- [Machines and daemon](architecture/machines.md): pairing, epochs, model and tool proxying, remote sessions
- [Access control](architecture/access.md): origin checks, token gate, capability routing
- [LLM gateway](architecture/llm-gateway.md): subscription accounts (Codex, Grok) and Gemini keys, CLIProxyAPI run as a child process of the host
- [Memory](architecture/memory.md): what is stored, how it is queried per conversation
- [Web](architecture/web.md): `web_fetch` and `web_search`, in the host process; SSRF guard, paging, the SearXNG it runs
- [Tasks](architecture/tasks.md): an agent proposes, the user confirms, the same agent executes in a fresh session
- [Tasks, artifacts and routines](architecture/tasks-artifacts-routines.md)
- [TUI](architecture/tui.md): the terminal interface `eta`, its connection, settings files and how to add a command or a screen; [commands](tui/commands.md)

UI conventions live in [DESIGN.md](../DESIGN.md) and [apps/web/AGENTS.md](../apps/web/AGENTS.md).

## Environment and setup

Needs Bun 1.4.3 (`bun check` is what every package type-checks with) and uv (Python 3.13, fetched by
uv from `.python-version`). The LLM gateway's CLIProxyAPI binary comes with `bun install`. Nothing else
to install and no service to stand up.

```sh
bun run setup     # bun install + uv sync
bun run dev       # host and web dev server
bun run check     # everything CI runs
```

`bun run dev` starts the host and vite together:

- Web: http://127.0.0.1:3000 (`ETA_WEB_PORT` changes the port)
- host: http://127.0.0.1:8787 (`ETA_PORT` changes the port), data in `~/.eta/` — the same directory an
  installed instance uses; vite proxies `/ws` to it and the host allow-lists vite's origin

In the web UI, add a model service under Settings → Model services first (an API key, or a device-code
link for a Codex or Grok subscription, or a Google AI Studio key), then create agents and conversations.

`bun run check` is `dprint check`, `bun run lint:repo` (root eslint) and
`turbo run build typecheck lint test knip`. `bun run format` formats with dprint. CI and the pre-commit
hook run the same set, through turbo's remote cache.

## Running from a checkout

On a Linux or macOS computer, from a checkout, as your own user service:

```sh
bun run host:install -- --host tailscale --port 8790
```

This builds the web, stages the compiled host the way the desktop app carries it (page, migrations,
CLIProxyAPI and the daemon for every platform), puts it in `~/.local/share/eta/host`, and runs
`eta-host install-service <flags>`: a systemd user unit (`io.eta.host`) or launchd agent that starts at
login and restarts on failure, with the PATH you installed from (so agents find git, gh, Claude Code,
Codex). Running it again after `git pull` is one way to upgrade; the daemons follow on their next connect.
On a headless Linux box, `loginctl enable-linger` keeps user services up without a login.
`~/.local/share/eta/host/eta-host uninstall-service` removes the service; the data stays in `~/.eta`.

Or run the host by hand:

```sh
bun run --cwd apps/web build
HOME=/var/lib/eta bun apps/eta/src/main.ts --web-dir apps/web/dist --host 0.0.0.0 --port 8787
```

To build the daemon on its own:

```sh
bun run --cwd apps/daemon build           # produces apps/daemon/out/eta-daemon
```

## Releases

How a version is tagged, built, checked and published: [Release](release.md).
