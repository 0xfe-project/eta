<p align="center">
  <img src="public/Eta-Banner.png" alt="Eta" width="900" />
</p>

<h2 align="center">
  Who's holding the AI that knows you?
</h2>

<p align="center">
  <strong>100% transparent. 100% yours.</strong><br />
  An open-source workbench for always-on agents that run on your machine, answer with your own model
  accounts, and keep everything they know in one SQLite file you can open.
</p>

<p align="center">
  <a href="#tldr">TL;DR</a> ·
  <a href="#what-it-is">What it is</a> ·
  <a href="#the-part-where-we-disagree">The part where we disagree</a> ·
  <a href="#install">Install</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="#license">License</a>
</p>

## TL;DR

Grok Bot says every agent gets its own computer. True. That computer sits in xAI's datacenter.

Muse gets your mail, your photos, your shopping. Today gets your calendar, your meetings, your work
chat, and promises the memory is "readable, editable, erasable" — on their servers, on their word.

Grok Bot, Muse, Today: different logos, the same trade. They learn everything about you, and they keep
it somewhere you will never be allowed to look.

**We don't think you have to accept the second half.**

eta is the same product with the address changed. The thing that knows you lives on the machine under
your desk. Read its source, watch what it does, swap the model, open the database, carry the whole
thing to another machine with `cp -r`.

> One process. One SQLite file. Zero required external services. 100% BYOK.

## What it is

A workbench where one person directs a crew of always-on agents: each one has a persona, a project it
belongs to, its own tools and its own memory. You talk to them, hand them tasks, put things on a
schedule — and when something needs your OK, they stop and wait for it. Long jobs survive the
conversation that started them; wake-ups arrive only with what's new since the last time the agent
looked.

Nothing here is a black box, because there is no box:

- **Every agent has its own computer — and it's yours.** Run the host on your laptop and the sessions
  run there. Add a second machine and the sessions move: the daemon dials out to you, shows a
  fingerprint, and waits for you to approve it.
- **100% BYOK, not "supports BYOK".** Your ChatGPT, Grok and Gemini subscriptions by device code, any
  OpenAI-compatible endpoint, and the private model in your own rack. A first-class citizen, not a
  compatibility mode. Nothing is routed anywhere you didn't point it.
- **Memory is a SQLite file.** One file, in the same data directory as everything else, queried per
  conversation. Open it, grep it, fix a row, delete a row. Delete it and it's actually gone.
- **You can see the work.** Every turn and every tool call — what it read, what it ran, what it
  changed — lands on a timeline instead of a spinner. When an agent wakes up, it gets the increment,
  not a rewrite of the whole story.
- **Nothing to cancel.** No seat, no credits, no rate limit we invented. There is no account to be
  banned from, because there is no account.
- **The door has a lock that turns itself on.** Bind anything other than loopback and the token gate
  comes up on its own. A file on disk, mode 0600, `Authorization: Bearer` for scripts.

And it's all there to change. Prompts are files, personas are markdown cards, tools are plugins, the
wire is documented frame by frame. If the runtime doesn't behave the way you need, it's not a feature
request away — it's right there.

## The part where we disagree

**Grok Bot** Every agent gets its own computer — in their datacenter, on their dynamic router, which
conveniently never tells you which model actually answered.

**Muse** Ten million users in forty days, and the most popular thing to do with it is shopping. It's
not a workbench, it's a storefront that remembers your address.

**Today** "Memory you can read, edit and erase." Great. Ship me the file, then.

**Claude Code** Useful? Yes. Yours? Not really.

**Codex** The prompt, the state, the context and the storage move around while you're expected to
smile and trust the dashboard.

**OpenCode** If the runtime ignores your plan, that isn't autonomy, it's an argument you keep losing.

## Install

There are two ways to run eta. **We recommend installing the host** on a computer that stays on — a
home server, a desktop, a small VPS. Your agents keep working while your laptop is closed, and you
reach the same eta from any browser or your phone.

### Recommended: install the host

eta is one file, `eta-host`. It serves the web app, keeps everything in `~/.eta`, and needs nothing
else running. Builds for Linux x64, macOS (Apple silicon) and Windows x64 are on
[Releases](https://github.com/0xfe-project/eta/releases/latest).

On Linux:

```sh
curl -LO https://github.com/0xfe-project/eta/releases/latest/download/eta-host-linux-x64
chmod +x eta-host-linux-x64
mkdir -p ~/.local/share/eta/host
mv eta-host-linux-x64 ~/.local/share/eta/host/eta-host
~/.local/share/eta/host/eta-host install-service --host tailscale
```

That starts eta now and at every login, listening on your tailnet; leave out `--host` to keep it on this
machine only. On a headless box, `loginctl enable-linger` keeps it running without a login. Open
`http://<this machine>:8787`. Anything other than localhost turns on a token by itself: the first visit
is `http://<this machine>:8787/?token=<token>`, with the token from `~/.eta/access-token`.

On macOS, use `eta-host-darwin-arm64` the same way, and clear the download flag before the first run
(`xattr -d com.apple.quarantine eta-host-darwin-arm64`): the build is not signed yet.

On Windows, download `eta-host-windows-x64.exe` and run `eta-host-windows-x64.exe install-service` in an
Administrator terminal. It runs as a Windows service under your account and asks for your password once,
which it hands to Windows without storing it.

To try it without installing anything, run the file directly (`./eta-host-linux-x64`): eta runs in that
terminal until you stop it.

### Experimental: the desktop app

Prefer to just open an app? Download the desktop installer for your system from
[Releases](https://github.com/0xfe-project/eta/releases), open it, choose **Run on this computer**, and
it sets everything up by itself.

> The desktop app is experimental. eta runs only while the app is open and the computer is awake, and
> other devices can't reach it. For an assistant that is always there, install the host on a server
> instead — the app can connect to that host too (**Connect to an existing host**).

## First steps

Settings → Model services → Add a source: sign in with a ChatGPT or Grok subscription, or paste an API
key. Then create an agent and start a conversation.

## Updating

Settings → Update, or `eta-host upgrade`. It verifies the download, waits for working agents, backs up
the database to `~/.eta/backups`, restarts the service, and goes back to the old version on its own if
the new one does not start. The machines you added follow on their next connect.

## More machines

Sessions can run on other computers too. Settings → Machines → Add a machine gives you a command to run
there; it shows a fingerprint, and the machine joins once you approve it. See
[Self-hosting](docs/self-hosting.md#more-machines-the-daemon).

## Documentation

- [Self-hosting](docs/self-hosting.md): flags, the token, reverse proxies, more machines, upgrades
- [Development](docs/development.md): the layout, working from a checkout, checks
- [Release](docs/release.md): how versions are built and published, checksums
- [Architecture](docs/architecture/overview.md): processes, the wire protocol, data, access control

## License

eta is under the [MIT License](LICENSE). What it carries from others keeps its own terms: the Eta Sans
font is not covered by the MIT License, and a compiled host embeds SearXNG, which is AGPL-3.0-or-later.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
