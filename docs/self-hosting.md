# Self-hosting

Everything about running the host once it is installed: flags, the token, reverse proxies, more
machines, upgrades. Installing it is in the [README](../README.md#install).

## Running the host

`eta-host install-service [flags]` registers the file it is run from as a service, with the flags you
give it, and starts it: a systemd user unit (`io.eta.host`) on Linux, a launchd agent on macOS, both
started at login and restarted on failure. It records the `PATH` you ran it from, so agents find git,
gh, Claude Code and Codex. Running it again changes the flags and restarts. On a headless Linux box,
`loginctl enable-linger` keeps user services up without a login. `eta-host uninstall-service` removes the
service; the data stays in `~/.eta`.

On Windows, `eta-host.exe install-service [flags]` in an Administrator terminal makes it a real Windows
service, started at boot. It asks for your Windows password once, because the service runs as you (so
agents can read your Claude, Codex and gh logins), and hands it to Windows without storing it.

`--host tailscale` listens on the tailnet address only, which is what other machines join over. Without
`--host` the host stays on `127.0.0.1`.

The data directory is always `$HOME/.eta`; there is no switch. To move it, move `HOME` (in systemd,
`Environment=HOME=/var/lib/eta`).

## Upgrading

Settings → Update, or from a terminal:

```sh
~/.local/share/eta/host/eta-host upgrade            # the latest full release; --check only says
~/.local/share/eta/host/eta-host upgrade 0.2.0-rc.1 # a pre-release has to be named
```

It checks the download, waits for working agents (`--force` does not), backs up the database to
`~/.eta/backups`, restarts the service, and goes back on its own if the new build does not hold. A
process of its own does this, so it outlives the terminal and the host.

Releases come from the repository the build was released from, so a fork's builds follow the fork.
`--repo <owner>/<name>` or Settings names another one, a private one included, with `gh`'s login,
`GH_TOKEN`, or a token saved in Settings. That choice decides whose code the host runs; see
[Release](release.md).

## Flags

Host flags (`apps/eta/src/main.ts`):

| flag                  | meaning                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--port <n>`          | port, default `8787` (`0` picks any free port)                                                                                                                                                                                                                                 |
| `--host <addr>`       | interface to bind, default `127.0.0.1`; `tailscale` is this computer's tailnet address. **Binding anything other than loopback turns the token gate on**                                                                                                                       |
| `--web-dir <dir>`     | built web (with `index.html`). A compiled host defaults to the page inside it; otherwise without it the host serves the pipe only, no pages                                                                                                                                    |
| `--token-file <path>` | turn the token gate on with an explicit token file (created if missing, mode 0600). Binding a non-loopback address without this uses `<data directory>/access-token`                                                                                                           |
| `--allow-origin <o>`  | extra page origin allowed to open the WebSocket, repeatable. Set it when you sit behind a reverse proxy that rewrites `Host`                                                                                                                                                   |
| `--no-llm`            | don't load the LLM gateway (no subscription accounts, no Gemini keys)                                                                                                                                                                                                          |
| `--searxng-url <url>` | the SearXNG `web_search` asks (`ETA_SEARXNG_URL` counts too). Without it the host runs the prebuilt SearXNG as a child process on first search, on linux-x64 (glibc 2.35+), darwin-arm64 and win32-x64; elsewhere agents get `web_fetch` only (see [Web](architecture/web.md)) |
| `--no-web`            | don't give agents `web_fetch` and `web_search`                                                                                                                                                                                                                                 |

First visit to a gated host: open `http://host:8787/?token=<token>` once in the browser, then the
cookie takes over; scripts use `Authorization: Bearer <token>`. `/up` is the health check and needs no
token. Details in [Access control](architecture/access.md).

## Behind a reverse proxy

Set `ETA_ALLOW_ORIGIN=https://your.domain`, and give the host `--allow-origin https://your.domain` when
the proxy rewrites `Host`. The proxy has to upgrade WebSocket for `/ws` and `/machines/connect`. `/up`
is the health check and needs no token.

Run it under systemd with `HOME=/var/lib/eta` and everything — database, sessions, artifacts, memory —
lives in that one directory.

## More machines: the daemon

The daemon is a single file (`eta-daemon`) that runs sessions on another machine; it holds no web, no
database and no model configuration — model calls and product tools all go back to the main node. The
host carries the daemon for every platform, and Settings → Machines hands out the command to install it.

1. In the main node: Settings → Machines, add a machine, and get a command (the install code is valid
   for 24 hours and works once).
2. On that machine run `eta-daemon setup <main node address> <install code>`. It generates a key
   locally and shows the fingerprint, then waits for approval.
3. Check the fingerprint matches in Settings, then approve.
4. `eta-daemon run` starts it; `eta-daemon install-service` registers a systemd user service (Linux) or
   a launchd agent (macOS).

The daemon only dials out to the main node, which therefore has to be reachable from it (a reverse
proxy has to upgrade `/machines/connect`). Its data directory is `~/.eta/daemon`, the same root as the
host, decided by `$HOME` — no switch. How it works: [Machines and daemon](architecture/machines.md).

## Memory

Memory is a SQLite file in the data directory, next to the sessions and the artifacts, and it is
queried per conversation. There is no separate service to run and nothing to configure: it comes with
the install, it travels with `$HOME/.eta`, and a row you delete stays deleted. See
[Memory](architecture/memory.md).

## Access

Origin checks on the pipe, a token gate that comes up automatically on a non-loopback bind, and
capability routing so a daemon sees only what it needs. The full story is in
[Access control](architecture/access.md).

## Unsigned builds

The host and the desktop installers are not signed yet. On macOS, clear the download flag before the
first run: `xattr -d com.apple.quarantine eta-host-darwin-arm64` for the host, and
`xattr -dr com.apple.quarantine /Applications/eta.app` for the desktop app. On Windows, when SmartScreen
says "Windows protected your PC", choose "More info", then "Run anyway". Details and checksums:
[Release](release.md#download-and-run).
