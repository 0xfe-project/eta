# Machines and daemons

The main node hosts the Web, product data, model credentials, and the memory sidecar. Other machines run a lean daemon, not the full eta.

## machine

`kind` in the `machine` table:

| kind      | Meaning                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| `primary` | The computer hosting the deployment, created automatically at startup (a unique index guarantees only one). Sessions run in-process |
| `daemon`  | A machine running `eta-daemon`. Status `pending` (registered, awaiting user approval), `online`, `offline`, `revoked` |
| `ssh`     | The schema retains this value; SSH-based execution environments are in `packages/eta-ssh`, `eta-plugin-ssh`; currently there is no corresponding add entry point in the product |

A project points to a machine (`project.machine_id`); the session in the conversation runs on the machine where the project is located, with the project's directory as cwd.

## What the daemon is

`apps/daemon` is built with `bun build --compile` into the single-file `eta-daemon` (`bun run --cwd apps/daemon build` → `out/eta-daemon`). It contains only the kernel, harness, execution, session storage, and the upstream server's SessionManager and sessions plugin: **no Web, no SQLite, no product plugins, no providers configuration**. A session's kernel and journal are both on this machine; the data directory, like the host's, is determined by `$HOME`: `~/.eta/daemon` (one root; the host occupies the top level, the daemon occupies `daemon/`; `~/.eta/mcp.json` and the persona card live in the same root, no borrowing across trees). There is no `--data-dir`, and no `ETA_DAEMON_DIR`.

```text
eta-daemon setup <primary-url> <code> [--no-wait]   Exchange the install code for a slot and wait for approval (--no-wait returns immediately after registering)
eta-daemon run                           Connect to the main node and serve (default command)
eta-daemon install-service               Register as a systemd user service (Linux) or launchd agent (macOS)
eta-daemon uninstall-service
eta-daemon version                       Print the build version
```

The first release supports Linux and macOS; Windows goes through WSL. It registers a user-level service, requires no root, and the daemon runs as the same user that the session needs to read and write files as; the service unit does not specify a data directory—the `HOME` of a user service is that user's home directory, so the location is stated in exactly one place.

Versions before this change stored data in `~/.eta-daemon`. When the new version finds the old directory still present and the new directory absent, it **refuses to start** and prints a migration command; it does not treat it as an empty directory: that would mean the sessions are still on disk but are all gone on the main node side. If an old service was already registered, first run `uninstall-service` with the old version, then `mkdir -p "$HOME/.eta" && mv "$HOME/.eta-daemon" "$HOME/.eta/daemon"`, and then run `install-service` again with the new version.

## Pairing

Onboarding follows "a single command with a one-time install code":

1. The settings page (`machines.enroll`) generates an install code, **valid for 24 hours, one-time**; the main node stores only its digest (`machine_enrollment`). The UI gives the full command: `eta-daemon setup <main node address> <code>`.
2. Run it on the new machine. The daemon **generates locally** a 32-byte key (`identity.json`, directory 0700, file 0600), uses the key's SHA-256 as the "fingerprint", and along with the hostname, home, and OS, calls `POST /machines/enroll`. The main node verifies the install code, creates a `pending` machine, and stores only the fingerprint (the key itself never leaves the daemon).
3. The daemon's terminal displays the fingerprint (in groups of eight characters), and the settings page displays the same fingerprint; the user **clicks approve after verifying they match** (`machines.approve`).
4. After the daemon connects, it receives the approval and becomes `online`.

Wrong install code attempts are rate-limited (too many errors within 10 minutes are rejected), and the request body has a size limit. Revoking (`machines.revoke`) cuts this connection and refuses further connections; it **does not** stop sessions already running on that machine.

### tailnet

When the main node is on the tailnet (`main.ts` reads the `tailscale` command by default; there is no JS SDK, and the output of `status --json` and `whois --json` is stable), three things become simpler (`apps/eta/src/machines/tailscale.ts`):

- **Address**: `--host tailscale` listens on the machine's tailnet address; new machines default to dialing the main node's MagicDNS name (when listening on the tailnet address or all interfaces).
- **Approval-free**: On `POST /machines/enroll`, use the TCP peer address for `whois` (the address recorded by the transport layer, trusting no headers). If the logged-in user is the same as the main node itself and it is not a tagged node (tagged nodes do not belong to any user), let it through directly and record its node id (`machine.tailnet_node`). For other people's nodes, tagged nodes, and nodes not on the tailnet, verify the fingerprint as usual.
- **Discovery**: `machines.discover` lists tailnet nodes and marks which are the user's own and which are already machines here (by node id, then by name).

### One-step install over SSH

`machines.install { host }` (`apps/eta/src/machines/install.ts`) uses the user's own `ssh` (OpenSSH or Tailscale SSH, `BatchMode`, never asks for a password) to do what a person would do by hand: `uname` to determine platform → transfer the build for that platform that the main node carries to `~/.eta/bin/eta-daemon` → use the new install code `setup --no-wait` → `install-service`, and on Linux also try `loginctl enable-linger` (so the user service survives the SSH session; a refusal is not a failure). If any step fails, the error says which step and what the other side said. Afterward it dials in like any other daemon; the user's own nodes on the tailnet are let through directly.

## One WSS, three kinds of traffic

The daemon is **outbound-only**: it dials back to `GET /machines/connect` (WebSocket), with credentials in the handshake's `Authorization` header, never in the address. One connection carries three channels (`packages/client-contracts/src/link.ts`):

| Channel | Direction        | Content                                                                                                                                                                                     |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipe` | main node → daemon | The ordinary eta pipe protocol. The daemon is an eta server without its own socket, and the main node is its client: `sessions.*` means the same here as elsewhere                                                                  |
| `svc`  | daemon → main node | The few things the daemon lacks: generation (`model.stream`), product tools (`tool.call`), approval list (`tool.gate`), MCP credentials (`mcp.credential`), GitHub token (`github.credentials`), question notifications (`ask.observe`) |
| `ctl`  | Both directions  | `welcome` (which machine, which connection number, whether approved), `approved`, heartbeat                                                                                                 |

Therefore **model credentials, OAuth tokens (including subscription accounts in the LLM gateway), and usage live only on the main node**: when the daemon needs to generate, it hands the request to the main node; the main node resolves the model, adds credentials, streams back from the provider, and sends it back event by event while counting usage. Product tools (tasks, artifacts, memory, `mention`, `web_fetch` / `web_search`, etc.) run on the main node for the corresponding session. Their execution environment is the SSH environment over the link, so reading a file reads the file on that machine; reading a web page is done by the main node itself. Every call carries a session id, and **only the main node's own row is trusted**: the machine the link belongs to must be the machine of that session's project.

## Version: the daemon follows the main node

The daemon is part of the main node. The build script (`apps/daemon/scripts/build.ts`; `build:all` is four platforms) writes the version into the binary with `--define` (`ETA_DAEMON_VERSION`, determined by the tag at release time, defaulting to the commit, with a timestamp added when the working tree has changes), and writes `out/dist/manifest.json`. The main node carries these builds: when running from source it reads the checkout's `apps/daemon/out/dist`; the packaged host embeds the four-platform builds compressed with zstd in the executable (`apps/eta/scripts/build-host.ts`), carrying `manifest.json` as-is, where `sha256` and `size` refer to the decompressed files. Only when a particular build needs to be served is it decompressed to `~/.eta/unpacked/daemon-<hash>/`, verified against sha256, and used; asking only for the version does not decompress.

- The daemon reports `version`, `platform` (`linux-x64`), `install` (`service` / `binary` / `source`, based on systemd's `INVOCATION_ID` and launchd's `XPC_SERVICE_NAME`), and link protocol `protocol` (`LINK_PROTOCOL`; an old daemon that does not report it counts as 1) in `machine.info`. The main node stores them in the `machine` row.
- **When the version on connect differs from the one carried**, make it switch before letting it do anything (`upgrade` over `svc`): the daemon uses its own credentials to `GET /machines/daemon/<platform>` for the build, verifies sha256, writes it next to the executable, first runs `version` once to check it starts and the version matches; then renames the old file to `.prev`, puts the new file in place, leaves a marker in the data directory, and exits with 75. systemd's `Restart=on-failure` and launchd's `KeepAlive.SuccessfulExit=false` both restart it on a non-zero exit. Signing is unnecessary: the link is authenticated, and the main node can already `exec` on the daemon.
- **Settle the marker when the new build starts**: if it reconnects within 90 seconds, delete the marker and `.prev`; if it does not reconnect, or fails to reconnect after 3 starts, put `.prev` back and exit, and the service brings up the old version.
- If it cannot switch (not a service, running from source, no build for the platform), let it in as before, with the reason written to `machine.update_error` and shown on the settings page; do not retry for the same machine and same target version within an hour, and `machines.upgrade` is a manual retry. Only reject a connection when the protocol is incompatible and it cannot switch.
- The machine list's `build` is `current` / `outdated` / `updating` (null when there is no build or it is not a daemon).

## Agents pinned to a machine

An agent can have a `machine_id` (null means follow the project). A pinned agent's sessions in any project are created on its machine, and external runtimes (Claude Code, etc.) use the ones on that machine; `agents.runtimes { machineId }` asks that machine which runtimes it has over the link.

- Which machine a session is created on is recorded in `participant.machine_id` (null for old behavior, meaning the project's machine); `ofSession` and `sessionsOn` route by it. When an agent changes machines, the next wake opens a new session on the new machine.
- A task's run is also on the agent's machine (`task_run.machine_id`). When it is not on the project's machine, no project directory is available: cwd is that machine's home, and no worktree is created.
- When not on the project's machine, the agent's system prompt (the platform section, which does not go into the conversation record and is invisible to the frontend) gets an extra paragraph stating only definite facts: which machine it is on, which machine this conversation or task belongs to, and that paths in the context may be on that machine, so it should find the resources it needs on the current machine itself. This section counts toward the session's stamp, and the session reopens when it changes.

## Epoch and bounds

- **Every connection is a new epoch** (monotonically increasing on the main node). A new connection from the same device replaces the old one (close code 4001), and in-flight calls on the old connection fail as "result unknown".
- **Reconnection after a disconnect does not replay in-flight calls**. The daemon reconnects with increasing intervals (starting at 1 second, capped at 30 seconds, reset after a successful connection); when the link drops, the main node marks in-flight calls as unknown and does not resend them, to avoid duplicate execution.
- Everything is bounded: a single frame is at most 8 MiB (exceeding it closes with code 1009), up to 64 in-flight calls per side, 30 seconds for a normal call, a run lasts at most 2 hours, heartbeat every 15 seconds, and 45 seconds of silence is treated as a disconnect.
- **Large files**: the per-frame limit is unchanged, but file reads are split into windows: when the execution environment (`packages/eta-ssh`) reads a whole file, it pulls at most 3 MiB per window (about 4 MiB after base64), and the first window also reports the file size; small files still take only one round trip. Binary and text (including UTF-8 multibyte characters spanning windows) are concatenated as bytes and then decoded. The same applies to SSH transfers.

## Sessions on the remote side

A task's run is also such a session (the key is `task:<task id>`, shared by multiple runs of one task; ownership follows the primary's `task_run` row), and the number of tasks a machine can run at once is its setting (`machine.max_active_runs`, default 2), see [Tasks](tasks.md).

- Before a reply enters working, `machine.lastSeq` asks the daemon how far this session's journal has been written, and records it in the reply row's `data.runFrom`. The page counts only transcript rows with a larger sequence number as part of this round: sequence numbers are assigned by the journal itself and do not involve the clocks of the two machines. If an old daemon does not have this action, the reply runs as usual, just without `runFrom` on the row.
- **GitHub login**: git and gh on the daemon machine log in as a GitHub App (the user if the user has authorized). The daemon asks the main node for a token via `svc`'s `github.credentials` (at most one hour; `null` if not connected) and writes it to `github/` in its data directory, then asks again before it expires; when GitHub is connected, authorized, or disconnected, the main node sends `machine.githubRefresh` so it asks again immediately. The App's private key, secret, and refresh token never leave the main node, see [GitHub](github.md).
- **Plugins**: files are synced to the daemon by content hash, and configuration values exist only in memory, see [Plugins](plugins.md).
- The engine asks for a "place" (`SessionPlace`) to get an agent's session: locally it is `LocalPlace`, remotely it is `RemotePlace`: one `machine.open` aligns the session and the agent, and the agent's instructions, model, thinking level, persona card, and product tool list are sent along with the call (the daemon registers proxy tools, and calls come back to the main node to execute). After that, one run is a long call (`machine.run`), and steer/stop are ordinary `sessions.*` calls on the daemon pipe.
- **Mirroring**: when a browser subscribes to `sessions.<id>`, it does not need to know which machine the session is on. The main node registers a target with the same name for the remote session; when someone subscribes, it subscribes to the same target on the daemon and republishes its state (full snapshot first, then patches) and events as-is; when no one is watching, it unsubscribes. If the link drops, everything goes cold, and after recovery only those still being watched are woken again. On resubscribe, the daemon replays the event ring from the beginning; event frames carry `at` (the time it happened, in milliseconds, strictly increasing within the same target and not going backward after a daemon restart), and the mirror forwards only events later than the last one it forwarded, so the browser never sees duplicate events.
- **Global list**: while the link is online, the main node subscribes to the daemon's own `sessions` list and merges its sessions into the global `sessions`' `list` (the row has `machine`, i.e. the machine name). When the daemon is unreachable, keep the last rows, mark them `offline`, and remove `running`.
- **Questions during disconnection**: questions, answers, and cancellations on the daemon notify the main node via `ask.observe`; when the link is down these notifications are queued (at most 256, oldest dropped first), and resent in order once the next link connects. The main node starts answering immediately after connecting (it need not wait for the machine to be reported ready).
- After the main node restarts, it learns from the `participant` rows which sessions are on which machine and reattaches them; when a daemon restarts, it reads sessions back from the journal.
- Calls to `sessions.*` are routed to the machine where the session lives (`RemoteSessionsRouter`), with a 1-minute limit for regular calls and 10 minutes for long calls.
