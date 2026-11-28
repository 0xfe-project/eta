<p align="center">
  <img src="public/Eta-Banner.png" alt="Eta" width="900" />
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<h2 align="center">
  Command a fleet of coding agents. Ship across every machine.
</h2>

<p align="center">
  Put <strong>Claude Code</strong>, <strong>Codex</strong>, <strong>Antigravity</strong>, <strong>OpenCode</strong>, <strong>Pi</strong>, <strong>ACP</strong>, and native Eta agents in the same room — backed by a <code>git worktree</code> task board with dependency plans, an autonomous <strong>Captain</strong>, remote worker machines, and native apps across desktop, mobile, web, and terminal.
</p>

<p align="center">
  <a href="#any-coding-agent-one-control-plane">Agents</a> ·
  <a href="#install">Install</a> ·
  <a href="#multi-agent-war-rooms">War Rooms</a> ·
  <a href="#captain">Captain</a> ·
  <a href="#task-board--dependency-plans">Task Plans</a> ·
  <a href="#ship-across-every-machine">Machines</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#documentation">Docs</a>
</p>

---

## Any Coding Agent, One Control Plane

Bring different coding agents into the **same group chat** so they can plan, code, review, and hand off work together — sharing one task board, visual artifacts, MCP tools, and approval gates:

<p align="center">
  <img
    src="public/screenshot-war-room.png"
    alt="Eta group chat with Claude Code, Codex, Antigravity, and OpenCode collaborating via @mentions alongside inline benchmark artifacts and live member status"
    width="900"
  />
</p>

- **Built-in Eta agent** — works out of the box with any API key, subscription, or local model.
- **Major coding CLIs (powered by OAR)** — **Claude Code**, **Codex**, **Antigravity**, **OpenCode**, **Pi**, **Grok Build**, and **Qwen Code**.
- **Any [ACP](https://agentclientprotocol.com) agent** — plug in custom or community Agent Client Protocol agents on any machine.

---

## Install

Start by handing our agent runbook to your AI coding assistant, open a native desktop or mobile app, or deploy `eta-host` on an always-on machine so your agent fleet keeps shipping while your laptop is closed.

### Option 1 — Let Your AI Agent Install Eta (Fastest)

Hand this prompt to **Claude Code**, **Codex**, **Antigravity**, **Cursor**, **OpenCode**, or any coding agent. It inspects your machine using [INSTALL.md](INSTALL.md), picks the best path, and handles macOS quarantine removal, Windows SmartScreen, Linux Flatpak vs. `.tar.gz`, always-on host + Web UI, and mobile setup automatically:

```text
Read https://raw.githubusercontent.com/0xfe-project/eta/main/INSTALL.md and install Eta on this machine. Inspect my environment first, recommend the best path, handle any OS quirks, and verify it works.
```

### Option 2 — Native Apps (Desktop & Mobile — zero-terminal start)

Download the app for your device from the `desktop-v*` releases on [GitHub Releases](https://github.com/0xfe-project/eta/releases) (published separately from `v*` host releases), launch it, and choose **Run on this computer** (manages the local host automatically) or **Connect to an existing host**.

| Platform                      | Package                                                           | Notes                                                                                                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS** (Apple Silicon)     | `eta-desktop-darwin-arm64.dmg`                                    | Drag `Eta.app` to Applications; run `xattr -dr com.apple.quarantine /Applications/Eta.app` before first launch (unsigned build)                                                                       |
| **Windows** (x64)             | `eta-desktop-windows-x64.zip`                                     | Extract and launch `Eta.exe` (if SmartScreen prompts, click **More info → Run anyway**)                                                                                                               |
| **Linux** (x64)               | `eta-desktop-linux-x64.tar.gz`<br>`eta-desktop-linux-x64.flatpak` | `.tar.gz` supports in-app updates and local host management; `.flatpak` works across distros via `flatpak install --user` (pair with OS/remote `eta-host`; update by reinstalling the new `.flatpak`) |
| **Android** (8+, arm64/armv7) | `eta-android.apk`                                                 | Sideload APK; pair via host URL or QR code                                                                                                                                                            |
| **iOS** (15+)                 | `eta-ios.ipa`                                                     | Sideload via AltStore / Sideloadly or re-sign with your team profile                                                                                                                                  |
| **HarmonyOS**                 | `eta-harmonyos.hap`                                               | Sign with your developer certificate before installing on device                                                                                                                                      |

Prefer a browser or terminal? Every host serves the full **Web UI** on port `:8787`, and the standalone terminal **TUI** (`eta`) gives you full control from the shell. Desktop (`.dmg`, `.zip`, `.tar.gz`) and Android apps also receive signed **in-app / OTA updates** under **Settings → Update**.

### Option 3 — Always-On Host (24/7 fleets & multi-device access)

`eta-host` is a single self-contained binary on [Latest Releases](https://github.com/0xfe-project/eta/releases/latest) that serves the Web UI, runs agent sessions, and stores everything in `~/.eta`.

**Linux (systemd user service over Tailscale):**

```sh
curl -LO https://github.com/0xfe-project/eta/releases/latest/download/eta-host-linux-x64
chmod +x eta-host-linux-x64
mkdir -p ~/.local/share/eta/host
mv eta-host-linux-x64 ~/.local/share/eta/host/eta-host
~/.local/share/eta/host/eta-host install-service --host tailscale
```

- Omit `--host tailscale` to listen on `127.0.0.1` only. On headless servers, run `loginctl enable-linger` so the user service stays active after logout.
- Listening beyond localhost turns on an automatic token gate (`~/.eta/access-token`, mode `0600`). Open `http://<this-machine>:8787/?token=<token>` once in your browser or pair desktop and mobile clients from Settings.
- Want a quick trial without installing a service? Run `./eta-host-linux-x64` directly in a terminal.

**macOS & Windows:**

```sh
# macOS (Apple Silicon) — clear quarantine flag on unsigned binary
curl -LO https://github.com/0xfe-project/eta/releases/latest/download/eta-host-darwin-arm64
chmod +x eta-host-darwin-arm64
xattr -d com.apple.quarantine eta-host-darwin-arm64
./eta-host-darwin-arm64 install-service --host tailscale
```

On Windows, download `eta-host-windows-x64.exe` and run `eta-host-windows-x64.exe install-service` in an Administrator terminal to register a Windows service under your account (so agents inherit your `git`, `gh`, `claude`, and `codex` logins).

**Docker Compose:**

```sh
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml exec eta cat /data/.eta/access-token
```

### First 60 Seconds

1. **Connect models or local agents:** Open **Settings → Model services** to sign in with ChatGPT/Codex or Grok via device code, or paste OpenAI / Anthropic / Gemini / custom API keys. Any locally installed **Claude Code**, **Codex**, **Antigravity**, **OpenCode**, **Pi**, or **ACP** agent is discovered automatically.
2. **Assemble a specialist group:** Add distinct coding agents (`Claude Code`, `Codex`, `Antigravity`, `OpenCode`, or built-in Eta agents) with tailored instructions, models, and skills into a shared project group.
3. **Dispatch worktree-isolated tasks:** `@mention` teammates in the war room or promote work onto the Task Board — each task checks out its own `git worktree` (`eta/task-<N>`), tracks live progress, and reports back for your review.

---

## Multi-Agent War Rooms

Turn every repository into a shared war room where specialist agents collaborate alongside you on one timeline:

- **One room, specialized teammates:** Mix `Claude Code`, `Codex`, `Antigravity`, `OpenCode`, or built-in Eta agents in the same project chat; `@mention` whoever you need or designate a default **Steward**, and let agents hand work off to each other naturally.
- **Parallel work, mid-flight steering:** Run multiple agents side by side without waiting; jump in mid-turn to steer a running agent onto a better path or queue your next instruction.
- **Decisions and deliverables in one place:** Confirm task proposals, follow live progress cards, and open interactive web previews right inside the conversation.

---

## Captain

**Captain** is your autonomous fleet coordinator — watching every group, machine, and background run so nothing falls through the cracks:

<p align="center">
  <img
    src="public/screenshot-captain.png"
    alt="Eta Captain view showing fleet review observations, dispatched task #51, and a pending approval card for a scheduled routine"
    width="900"
  />
</p>

- **A supervisor watching your whole fleet:** Surfaces what finished, what stalled, and what needs your decision across every group and machine.
- **Delegate outcomes, not busywork:** Tell Captain the goal; it breaks work down, dispatches tasks to the right specialist groups, and tracks them to completion.
- **You stay in command:** Creating new agents, groups, or routines — and running sensitive tools — waits for your one-click approval.
- **Scheduled Routines:** Put recurring engineering tasks (benchmarks, audits, digests, nightly checks) on a schedule and refine them simply by replying to their reports.

---

## Task Board & Dependency Plans

Keep chat for alignment and move execution onto the **Task Board**, where every task runs in its own clean workspace:

<p align="center">
  <img
    src="public/screenshot-tasks-dag.png"
    alt="Eta Tasks Plan view displaying parent/subtask staging, dependency DAG edges, critical path, and multi-machine execution"
    width="900"
  />
</p>

- **Isolated `git worktree` per task:** Spin up parallel coding tasks in automatic worktrees (`eta/task-<N>`) without branch conflicts or dirtying your main checkout.
- **Visual dependency plans:** Split big features into subtasks and chain dependencies so downstream steps start automatically when prerequisites hit review or finish — across **Plan** (DAG), **Board** (Kanban), and **List** views.
- **Review with full memory intact:** Comment directly on a task in review to request tweaks; the agent continues in the same session without losing context.
- **Full visibility on every run:** Follow live tool activity, file diffs, terminal output, and token rollups right on the task card.

---

## Ship Across Every Machine

Scale from a laptop to Linux build servers, GPU workstations, and remote boxes with `eta-daemon`:

- **Zero inbound ports:** Worker machines dial out to your host after one-time fingerprint approval — no firewall openings or SSH key shuffling required.
- **Execute where the code and hardware live:** Worktrees, builds, and local CLIs run directly on the target machine while you manage every repo from one workspace. See [Self-hosting](docs/self-hosting.md#more-machines-the-daemon).
- **Zero-touch worker upgrades:** Paired service daemons update automatically alongside your primary host.

---

## Every Screen, Always in Sync

- **Native Desktop (`macOS`, `Windows`, `Linux`):** Embedded local host mode or connect to remote hosts, with signed in-app auto-updates on `.dmg`, `.zip`, and `.tar.gz` (Linux `.flatpak` pairs with a host-OS or remote `eta-host` and updates by reinstalling the new `.flatpak` bundle).
- **Native Mobile (`Android`, `iOS`, `HarmonyOS`):** Monitor war rooms, review task deliverables, and approve actions on the go with QR code pairing — plus signed OTA updates on Android.
- **Built-in Web UI (`:8787`):** Instant browser access served straight from `eta-host`.
- **Terminal TUI (`eta`):** Fast, keyboard-first terminal interface for local or remote hosts.

---

## Architecture

```text
  Native Desktop · Mobile · Web UI (:8787) · Terminal TUI (eta)
                               │
                     Real-Time WebSocket + HTTP
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  eta-host (Single Binary + ~/.eta/eta.sqlite)                    │
│                                                                  │
│  War Rooms · Captain · Task DAGs · Routines · Artifacts · Inbox  │
│  Models & Subscriptions · Plugins · Per-Agent MCP · Approvals    │
└──────────────┬───────────────────────────────────────────────────┘
               │ Outbound Worker Link
               ▼
   eta-daemon Worker Nodes
   (Remote worktrees, local CLIs, MCP)
```

---

## Plugins, MCP & Visual Artifacts

- **Plugins & integrations:** Add skills and tools from local folders, Git repositories, or the **Composio** marketplace, with encrypted secret storage.
- **Per-agent MCP:** Configure MCP servers per agent with one-click OAuth sign-in that carries seamlessly to remote machines.
- **Interactive Visual Artifacts:** Agents publish live HTML/React reports, dashboards, and prototypes you can safely preview in-app, download as a ZIP, or share via a revocable link.
- **Human-in-the-loop approvals:** Gate sensitive tools and answer agent questions from desktop or phone whenever your judgment is needed.

---

## And Yes — 100% Self-Hosted & Yours

- **One binary, one SQLite file:** Your entire state — agents, tasks, approvals, routine briefs, and encrypted credentials — lives in `~/.eta/eta.sqlite` beside plain JSONL transcripts. Move or back up everything with `$HOME/.eta`.
- **100% BYOK, zero lock-in:** Use your own API keys, ChatGPT/Codex or Grok subscriptions, or private endpoints. No seats, no credits, no cloud black box.
- **Full transparency:** Every turn, reasoning block, tool call, diff, and token count lives in your own database and timeline.

---

## Updating

Update from **Settings → Update** in the UI or via CLI:

```sh
eta-host upgrade
```

`eta-host upgrade` verifies `SHA256SUMS`, waits for running tasks, backs up `~/.eta/eta.sqlite` to `~/.eta/backups`, restarts the service, and rolls back automatically if the new build fails to start. Connected `eta-daemon` workers update on reconnect; desktop (`.dmg`, `.zip`, `.tar.gz`) and Android clients update in place via **Settings → Update**, while the Linux `.flatpak` bundle notifies there and updates via `flatpak install --user`.

## Documentation

- [Install Guide (Agent-Executable)](INSTALL.md) — automated install runbook for AI agents across macOS, Windows, Linux, Docker, and mobile
- [Self-hosting](docs/self-hosting.md) — flags, token gate, reverse proxies, `eta-daemon`, upgrades
- [Architecture Overview](docs/architecture/overview.md) — processes, wire protocol, data model, plugins
- [Development](docs/development.md) — repo layout, Bun/Node 24 setup, running from source, CI checks
- [Release](docs/release.md) — release pipelines, checksums, OTA manifests, upgrade testing

## License

Eta is licensed under the [MIT License](LICENSE). Bundled third-party components keep their own licenses — notably the Eta Sans / AKR DWG font is not covered by the MIT License, and compiled host binaries bundle SearXNG (`AGPL-3.0-or-later`). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
