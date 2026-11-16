# MCP

Agents use external tools via MCP. The library lives in `packages/eta-mcp` (`@eta/mcp`; its architecture comes from pi-mcp-adapter and it does not depend on any harness); the `McpHost` in `apps/daemon/src/mcp-host.ts` connects it to the sessions of a machine (the main node and every daemon make one each), and `McpService` (`apps/eta/src/mcp/service.ts`) adds the credentials, the logins and the settings page.

Both the main node and the daemon have MCP for eta's own loop. On a daemon (`apps/daemon/src/node.ts`), `McpHost` is the session manager's `mcpFor`; the daemon also gives its sessions on eta's own loop an ESM realm and the platform briefing (`platformFor`, without the config line: the providers are the primary's), which they had lacked, so `import "mcp:<server>"` has somewhere to run. Its sources are the same as the main node's, read on the daemon's machine: the agent's plugins (from the copies the daemon keeps, with the values `machine.open` sent), `~/.eta/mcp.json` in the daemon user's home, and the project's `.mcp.json`. Servers start on the daemon's machine. Its OAuth credentials are the main node's (see OAuth below). A session on an external runtime is given its plugins' servers by that runtime, on whichever machine it runs.

## What a session gets

- **One `mcp` proxy tool** (~200 tokens): status, list a server's tools, search, describe, `instructions`, call, connect. When no servers are configured, the session carries no MCP tools at all.
- **Direct tools**: for servers whose config sets `directTools` (`true` or a list of tool names), their tools appear directly in the tool list as `mcp__<server>__<tool>`. Definitions are taken from the metadata cache without connecting to the server; servers not yet cached are warmed up once in the background when a session opens (warmups for the same agent run one after another), and after the read completes, the direct tools are added to the running session.
- Servers are **lazily connected** (connect only on first call, disconnect after 10 minutes idle), and opening a session never waits for them.

## Configuration sources

Later sources override earlier ones for servers with the same name. The override is whole, not a merge of fields: the earlier server's `url`, `headers`, `env`, `auth` and everything else are dropped, and nothing connects to it (`resolveServers`, which lists what it replaced in `overridden`).

| Source            | Location                      | Description                                                                                 |
| ----------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| `plugin:<plugin>` | The agent's enabled plugins   | Only for agents on eta's own loop; one source per plugin, servers named `<plugin>-<server>` |
| `~/.eta/mcp.json` | This machine's user directory | For all agents on this machine                                                              |
| `.mcp.json`       | Session working directory     | Loaded directly, no approval needed (it is in the user's own project)                       |

Plugin sources come from `pluginMcpSources` (`apps/daemon/src/plugin-launch.ts`) through `McpHostOptions.pluginSources`: on the main node `Plugins.mcpSourcesFor(agentId)`, on a daemon the plugins of the agent's opening in that conversation. `McpHost` does not read plugin directories. They are resolved the same way as for an external runtime (see [plugins](plugins.md#what-a-session-gets)) and then take `@eta/mcp`'s shape: a stdio server keeps its own `cwd` (no `sh` wrapper), sse is taken, and a remote server's `auth` is what the extension declares (`mcp.<server>.auth`: `false` or `"oauth"`, see [plugins](plugins.md#configuration)), else `"oauth"` unless the extension already sends an `Authorization` header (`authOf` in `plugin-launch.ts`, the one place this is decided). The plugin's `mcp.json` itself is still read as the spec says, with no `auth` field.

The format is the usual `{ "mcpServers": { ... } }`, with additional fields such as `lifecycle` (`lazy` / `keep-alive` / `lazy-keep-alive`), `directTools`, `approveTools`, `auth` (`oauth` / `bearer`), and `includeTools` / `excludeTools`; see the library's `McpServerEntry`. These files are read once when a session opens; changes take effect for newly opened sessions.

The metadata cache, resolved results for `npx`/`bunx`/`uvx`, and the on-disk directory for oversized output live under `mcp/` in the data directory of the machine the session runs on. Neither file holds a server's configuration: the cache keys a server by a SHA-256 of what decides its tools (command, args, env, url, headers, auth), and stores the tools, instructions and observed output shapes; a launch resolution is keyed by the package spec and stores the binary it found. So a plugin's secret that reaches a server's `env` or `headers` is not written there in the clear. A tool's own output, if the server echoes a secret, can still reach the oversized-output directory.

## Isolation and sharing

Connections are keyed by (agent, server name): all sessions of the same agent on this machine share a connection, and two agents never share one. After the last session of an agent on this machine closes, its connection is kept for another minute before closing; when the host shuts down, all are closed.

## Hooks wired into sessions

- **Approval**: when `approveTools` (`true`, a tool name or wildcard, `"destructive"`) matches, it asks in the session's ask channel (options `allow` / `deny`), i.e. a card in the inbox, regardless of which machine the session is on.
- **Forms (elicitation)**: when a server asks for input mid-call, flat forms ask field by field: enums are options, booleans are yes/no, and text and numbers are free input (answer `-` to skip optional fields). A user refusal is `decline`; nested, multi-select, and URL-mode forms are cancelled, and a reason sentence is appended to the result of this call so the model knows.
- **akhook**: every call made via the proxy or a direct tool is passed to akhook's tool-call middleware as `mcp__<server>__<tool>` plus the tool arguments, so `on: tool_call` rules (`tools: ["mcp__github__*"]`), `ask` rules, and approval lists can all match the underlying MCP tools; a blocked call returns the rule's message to the model, and the server never receives the request.

## OAuth

Remote HTTP servers set `"auth": "oauth"`; a plugin's remote server has it unless its extension declares `auth: false` or, declaring nothing, sends `Authorization`.

`auth: false` means no sign-in will help: a 401 from such a server is a failure (`failed`, with an error that says it is a 401 and that the server is declared `auth: false`), held in the usual failure backoff, and never `needs-auth`, so no sign-in is offered and none can be started. This holds for `auth: false` in `~/.eta/mcp.json` and `.mcp.json` too; before, such a server showed as needing a sign-in.

- **Credentials** live in the main node's `credential` table (migration 0033, `integration = 'mcp'`). Each value is JSON, encrypted with AES-256-GCM using `secret.key` in the data directory, with a random 12-byte IV, stored as `iv | tag | ciphertext`; if tampered with or the key is changed, it cannot be read and is treated as not signed in. It stores `tokens`, `clientInformation`, `discoveryState`, and the `codeVerifier` for an in-progress login.
- **Server key** is the SHA-256 of the server URL (with the fragment removed): independent of agent and configuration source, so one login is valid for all agents and all machines.
- On connect, it uses the provider in connect mode (it never registers a client or redirects on its own; if login is missing, it reports “needs login”), and concurrent refreshes of the same refresh token are merged into a single request.
- **Login**: `mcp.login` returns `{ pendingId, authorizationUrl }`; the browser goes to authorize. The authorization server sends the browser back to `GET /mcp/oauth/callback?code&state` (exempt from the token gate; see [access control](access.md)); the host finds the login it is waiting for by `state` and completes it, returning a page saying “You can close this tab”. When the host is not at an address the browser can return to (headless, remote), the user pastes the address where the authorization server finally landed into `mcp.completeLogin`. After login completes, servers waiting on that login reconnect immediately.
- **Redirect URL** is `<origin>/mcp/oauth/callback`. The origin comes from the startup argument `--public-url` (or the environment variable `ETA_PUBLIC_URL`); if neither is set, it uses the `location.origin` reported by the web client in `login`: that is always an address the user's browser can open, and an address the page already trusts. If neither is available, login errors and prompts to set `--public-url`. The client registered with the authorization server remembers the redirect URL; if the address changes, it re-registers on the next login.
- **Only the main node signs in.** The browser, the callback and the PKCE verifier are the main node's. A daemon keeps no credentials: its provider (`apps/daemon/src/mcp-auth.ts`, connect mode) reads and writes the main node's rows over the link with `mcp.credential` (`{ op: get | set | delete, serverKey, kind }`). The main node's handler (`McpService.relay`, checked by `parseCredentialCall`) accepts only `tokens`, `clientInformation` and `discoveryState`, under a key shaped like a URL's SHA-256; anything else is refused and nothing is read or written. A token a daemon refreshes is saved there, so the next session on any machine reads it.
- **A login reaches a session already open on a daemon.** A `needs-auth` server is tried again on every call, and each try reads the credentials from the main node, so the first call after the login uses it; the session is not reopened.
- **A plugin's server shows a login only when it asked for one.** It is `auth: "oauth"` because nothing says otherwise, so it is `none` until the server answers 401 (`needs-auth` → `needs_login`), and `signed_in` once a login holds. A server the user declared `auth: "oauth"` in a file is `needs_login` until it has tokens. A server that is not `auth: "oauth"` is always `none`.

## wire：`mcp` target

`list` returns a section; each item (`McpServerView`): `agentId`, `agentName`, `server`, `source`, `transport` (`stdio` | `http` | `sse`), `lifecycle`, `state` (`connected` | `cached` | `not-connected` | `failed` | `needs-auth` | `disabled`), `toolCount`, `error`, `auth` (`none` | `signed_in` | `needs_login`), `overriddenBy` (`{ source, name }` of the server used instead, on a plugin's server another source replaced; otherwise `null`) and `overrides` (the `plugin:<plugin>` source a server replaced, or `null`). A replaced plugin server is listed under its plugin's source with `state: "not-connected"`, no tools and `auth: "none"`; only plugin servers are listed this way, not one user file replacing another. The content is the servers each agent gets from its plugins (eta's own loop only) and the user files, plus those read from the project `.mcp.json` by running sessions. Only the main node's configuration is listed: a server only a daemon's files declare, or its state there, is not shown.

| Action          | Description                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| `connect`       | `{ agentId, server }`: connects now, returns `{ ok, message }`                                             |
| `reconnect`     | Same as above; disconnects first and clears failed memory                                                  |
| `login`         | `{ agentId, server, redirectOrigin? }` → `{ pendingId, authorizationUrl }`                                 |
| `completeLogin` | `{ pendingId, callbackUrl }`: completes login using the redirect URL; if `state` is wrong, nothing changes |
| `logout`        | `{ agentId, server }`: forgets all credentials for this URL (all agents lose their login)                  |

## UI

Settings → MCP servers: grouped by agent, then by source; one row per server: name, transport and lifecycle, status, tool count, most recent error; OAuth servers have log in / log out. A plugin's server another source replaced stays in its plugin's group, muted and struck through, says “Overridden by `<source>`” in words and has no buttons; the server used instead says which plugin source it replaces. The page has no session's working directory, so a project's `.mcp.json` only shows (and only overrides) in the lists of running sessions; its description says so. Logging in opens the authorization provider in a new tab and shows a dialog where you can paste the redirect URL; once the callback logs the server in, the dialog closes automatically.

## Old implementation

`apps/daemon/src/mcp.ts` (each session connected separately, tool list read once, forms always canceled, tool name `server__tool`, engine had to wait for `settled`) has been deleted. Tool names are now the proxy tool's `tool` parameter or direct tools `mcp__<server>__<tool>`; opening a session no longer waits for the server; connections are shared between sessions of the same agent, and closing a session no longer kills the process.
