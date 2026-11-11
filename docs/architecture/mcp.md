# MCP

Agents use external tools via MCP. The library lives in `packages/eta-mcp` (`@eta/mcp`; its architecture comes from pi-mcp-adapter and it does not depend on any harness); the `McpHost` in `apps/daemon/src/mcp-host.ts` connects it to sessions. The main node and each daemon each use one, so MCP processes always start on the machine where the session is located.

## What a session gets

- **One `mcp` proxy tool** (~200 tokens): status, list a server's tools, search, describe, `instructions`, call, connect. When no servers are configured, the session carries no MCP tools at all.
- **Direct tools**: for servers whose config sets `directTools` (`true` or a list of tool names), their tools appear directly in the tool list as `mcp__<server>__<tool>`. Definitions are taken from the metadata cache without connecting to the server; servers not yet cached are warmed up once in the background when a session opens (warmups for the same agent run one after another), and after the read completes, the direct tools are added to the running session.
- Servers are **lazily connected** (connect only on first call, disconnect after 10 minutes idle), and opening a session never waits for them.

## Configuration sources

Later sources override earlier ones for servers with the same name:

| Source            | Location                      | Description                                                           |
| ----------------- | ----------------------------- | --------------------------------------------------------------------- |
| `~/.eta/mcp.json` | This machine's user directory | For all agents on this machine                                        |
| `.mcp.json`       | Session working directory     | Loaded directly, no approval needed (it is in the user's own project) |

The format is the usual `{ "mcpServers": { ... } }`, with additional fields such as `lifecycle` (`lazy` / `keep-alive` / `lazy-keep-alive`), `directTools`, `approveTools`, `auth` (`oauth` / `bearer`), and `includeTools` / `excludeTools`; see the library's `McpServerEntry`. These files are read once when a session opens; changes take effect for newly opened sessions.

The metadata cache, resolved results for `npx`/`bunx`/`uvx`, and the on-disk directory for oversized output live under `mcp/` in each machine's own state directory (for the main node, the data directory; for a daemon, its own).

## Isolation and sharing

Connections are keyed by (agent, server name): all sessions of the same agent on this machine share a connection, and two agents never share one. After the last session of an agent on this machine closes, its connection is kept for another minute before closing; when the host shuts down, all are closed.

## Hooks wired into sessions

- **Approval**: when `approveTools` (`true`, a tool name or wildcard, `"destructive"`) matches, it asks in the session's ask channel (options `allow` / `deny`), i.e. a card in the inbox, regardless of which machine the session is on.
- **Forms (elicitation)**: when a server asks for input mid-call, flat forms ask field by field: enums are options, booleans are yes/no, and text and numbers are free input (answer `-` to skip optional fields). A user refusal is `decline`; nested, multi-select, and URL-mode forms are cancelled, and a reason sentence is appended to the result of this call so the model knows.
- **akhook**: every call made via the proxy or a direct tool is passed to akhook's tool-call middleware as `mcp__<server>__<tool>` plus the tool arguments, so `on: tool_call` rules (`tools: ["mcp__github__*"]`), `ask` rules, and approval lists can all match the underlying MCP tools; a blocked call returns the rule's message to the model, and the server never receives the request.

## OAuth

Remote HTTP servers set `"auth": "oauth"`.

- **Credentials** live in the main node's `credential` table (migration 0033, `integration = 'mcp'`). Each value is JSON, encrypted with AES-256-GCM using `secret.key` in the data directory, with a random 12-byte IV, stored as `iv | tag | ciphertext`; if tampered with or the key is changed, it cannot be read and is treated as not signed in. It stores `tokens`, `clientInformation`, `discoveryState`, and the `codeVerifier` for an in-progress login.
- **Server key** is the SHA-256 of the server URL (with the fragment removed): independent of agent and configuration source, so one login is valid for all agents and all machines.
- On connect, it uses the provider in connect mode (it never registers a client or redirects on its own; if login is missing, it reports “needs login”), and concurrent refreshes of the same refresh token are merged into a single request.
- **Login**: `mcp.login` returns `{ pendingId, authorizationUrl }`; the browser goes to authorize. The authorization server sends the browser back to `GET /mcp/oauth/callback?code&state` (exempt from the token gate; see [access control](access.md)); the host finds the login it is waiting for by `state` and completes it, returning a page saying “You can close this tab”. When the host is not at an address the browser can return to (headless, remote), the user pastes the address where the authorization server finally landed into `mcp.completeLogin`. After login completes, servers waiting on that login reconnect immediately.
- **Redirect URL** is `<origin>/mcp/oauth/callback`. The origin comes from the startup argument `--public-url` (or the environment variable `ETA_PUBLIC_URL`); if neither is set, it uses the `location.origin` reported by the web client in `login`: that is always an address the user's browser can open, and an address the page already trusts. If neither is available, login errors and prompts to set `--public-url`. The client registered with the authorization server remembers the redirect URL; if the address changes, it re-registers on the next login.
- **The daemon does not store credentials.** Its provider reads and writes via `svc`'s `mcp.credential` by asking the main node: `get` / `set` / `delete`, allowing only `tokens`, `clientInformation`, and `discoveryState` (excluding the login `codeVerifier`); keys must be 64-digit hexadecimal (the URL hash, so the daemon can only touch servers whose URL it knows). After the daemon refreshes a token, the new token is stored on the main node, and the next session (on any machine) can read it. Login happens only on the main node: a server on a daemon that needs login reports “needs login”; after logging in from settings, it reconnects.

## wire：`mcp` target

`list` returns a section; each item (`McpServerView`): `agentId`, `agentName`, `server`, `source`, `transport` (`stdio` | `http` | `sse`), `lifecycle`, `state` (`connected` | `cached` | `not-connected` | `failed` | `needs-auth` | `disabled`), `toolCount`, `error`, `auth` (`none` | `signed_in` | `needs_login`). The content is the servers each agent gets from the user files, plus those read from the project `.mcp.json` by running sessions. Currently only configuration on the main node is listed; servers unique to a project on a daemon are not in the list.

| Action          | Description                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| `connect`       | `{ agentId, server }`: connects now, returns `{ ok, message }`                                             |
| `reconnect`     | Same as above; disconnects first and clears failed memory                                                  |
| `login`         | `{ agentId, server, redirectOrigin? }` → `{ pendingId, authorizationUrl }`                                 |
| `completeLogin` | `{ pendingId, callbackUrl }`: completes login using the redirect URL; if `state` is wrong, nothing changes |
| `logout`        | `{ agentId, server }`: forgets all credentials for this URL (all agents lose their login)                  |

## UI

Settings → MCP servers: grouped by agent, then by source; one row per server: name, transport and lifecycle, status, tool count, most recent error; OAuth servers have log in / log out. Logging in opens the authorization provider in a new tab and shows a dialog where you can paste the redirect URL; once the callback logs the server in, the dialog closes automatically.

## Old implementation

`apps/daemon/src/mcp.ts` (each session connected separately, tool list read once, forms always canceled, tool name `server__tool`, engine had to wait for `settled`) has been deleted. Tool names are now the proxy tool's `tool` parameter or direct tools `mcp__<server>__<tool>`; opening a session no longer waits for the server; connections are shared between sessions of the same agent, and closing a session no longer kills the process.
