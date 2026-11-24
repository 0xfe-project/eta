# Plugins

Plugins give agents skills and MCP servers, in the format [Agent Plugins 1.0.0](https://agent-plugins.org): a `plugin.json` at the root, with `skills/<name>/SKILL.md` and `mcp.json` in fixed locations. eta's private data lives in `extensions["tech.0xfe.eta"]`; clients that do not recognize this extension load it as an ordinary plugin.

The code is in `apps/daemon/src/plugin-*.ts` (reading, startup, and file sync shared by the main node and the daemon) and `apps/eta/src/plugins/` (sources, configuration, tools, wire). Field validation is a pure function in `packages/client-contracts/src/plugin-fields.ts`, shared by the host and the frontend; the host's result is authoritative.

## Where they come from

- **Local**: `~/.eta/plugins/<directory>/`; re-read on change. The main node compares file signatures (path, size, modification time) every 2 seconds, and again before opening a session. The directory name `data` is reserved by `PLUGIN_DATA` and is not treated as a plugin. This directory is also where eta-server user plugins live: those with `plugin.json` belong here, those whose `package.json` includes `eta-plugin` belong there; they do not interfere with each other.
- **git**: `{ repo, rev, path }`. Once `rev` resolves to a commit it is pinned and only moves when the user manually selects "Update". Files are in `<dataDir>/plugin-sources/`.

A plugin's identity is the manifest's `name`. Plugins rejected by the spec are also listed, displayed by directory name, with the reason.

## Spec failure boundaries

| Case                                                                                                                                           | Result                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `plugin.json` is missing, not valid JSON, has an unrecognized `$schema`, wrong field type, invalid name, or resolves outside the plugin root   | Reject the entire plugin                                  |
| Unknown top-level fields, `extensions` is not an object                                                                                        | Report and ignore; continue loading                       |
| Unimplemented namespace                                                                                                                        | Not read                                                  |
| `mcp.json` is not valid JSON, has an unrecognized `$schema` or version mismatch, has extra fields, resolves outside the root, or is not a file | MCP for this plugin is disabled; skills continue as usual |
| A single server is invalid (fields, reserved names in `command`, `cwd`, `url`, header, `env`)                                                  | Skip this server                                          |
| `sse` transport                                                                                                                                | Skip and report: oar's `McpServer` does not support it    |
| `skills` is not a directory                                                                                                                    | Skill is invalid; MCP continues as usual                  |
| A single skill does not conform to the Agent Skills spec or resolves outside the root                                                          | Skip this skill                                           |

Reports are shown under the plugin entry on the settings page. Only direct subdirectories of `skills/` are inspected; there is no deeper search.

## Configuration

`extensions["tech.0xfe.eta"]`：

```json
{
  "config": {
    "api_key": {
      "type": "string",
      "title": "API key",
      "required": true,
      "secret": true,
      "pattern": "^sk-"
    },
    "team": { "type": "string", "maxLength": 64 }
  },
  "mcp": {
    "server": {
      "env": { "SERVER_KEY": "api_key" },
      "headers": { "Authorization": "Bearer {api_key}" }
    }
  },
  "requires": ["node"]
}
```

- `config` is a closed schema, not JSON Schema. Shared keys are `type`, `title`, `description`, `required`, `default`, `secret`, `agent`; `string` has `pattern`, `minLength`, `maxLength`; `number` has `int`, `min`, `max`; `select` has `options`, `multiple`, `minItems`, `maxItems`. Any unknown key invalidates `config` as a whole: the plugin remains pending configuration, and the reason is reported.
- `secret: true` can only be used on `string`, and cannot have a `default`.
- `pattern` is executed with RE2 (`re2js`); matching time is linear in input length, so regexes written by authors cannot stall the host. Lookarounds and backreferences are not RE2 and make `config` invalid. Patterns are at most 512 characters, and string values at most 64 KiB.
- `mcp.<server>.auth` (`false` or `"oauth"`) says how a remote server signs in on eta's own loop: `false` never (a 401 is an error, and no sign-in is offered), `"oauth"` always may, even when `headers` send `Authorization`. Left out, it is OAuth unless `Authorization` is sent. It is ignored, and reported, on a stdio server; any other value skips the server. External runtimes are not given it.
- `mcp.<server>.env` and `headers` pass fields to the server; they are not written into `mcp.json`. `mcp.json` stays as the spec requires: `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded once, and nothing else is expanded. Multi-select fields are joined with commas. Fields without a value do not set this variable or add this header.
- `requires` is informational only: checked per machine, and anything missing is shown on the settings page.

There is one global configuration; it is `seal`ed into one JSON object and stored in `plugin_config`. Secrets are not returned over the wire; leaving blank means unchanged, and `null` means clear. The host refuses to save values that do not match the fields; missing required items can still be saved, with the state remaining pending configuration.

## Status

`Needs configuration` (`needs_config`) / `Ready` (`ready`). Missing required fields, saved values that do not match the current fields, or an invalid `config` all mean the plugin needs configuration. Only ready plugins can be selected.

When config is no longer valid after an upgrade, fall back to pending configuration: enabled agents remain checked, sessions skip it, and both the settings page and agent editor show a notice. It recovers automatically once fixed.

## What a session gets

A plugin also has one global switch (table `plugin_disabled`, default on; `plugins.setEnabled`). Off, `Plugins.#split` leaves it out for every agent, so `skillDirsFor`, `runtimeExtrasFor`, `mcpSourcesFor` and `stampOf` all see nothing of it, whatever the agent enabled; it applies at read time and open sessions reopen. On does not enable it for an agent: each agent's own choice (`agent_plugin`) is never touched by the switch. An off plugin stays installed with its values; removing its git source clears the switch.

| Runtime             | Skill                                                                                        | MCP                                                  |
| ------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Built-in kernel     | Directory wired into `skillDirsFor`, included in the skills block of the system prompt       | `McpHost`, source `plugin:<plugin>` (main node only) |
| Claude Code         | `--plugin-dir` natively loads a generated directory containing only valid skills             | oar's `mcpServers`                                   |
| Codex, OpenCode, Pi | Name, description, and path written into the system prompt; the agent reads the files itself | oar's `mcpServers`                                   |

Claude Code cannot use the plugin directory directly: `--plugin-dir` treats it as a Claude plugin, runs its `hooks/`, and loads its `commands/`, which eta does not support. The generated directory is at `<dataDir>/plugin-runtime/claude/<content hash>/<plugin name>/skills/`, containing symlinks to valid skills.

Both go through one resolution, `resolvePluginServers` in `apps/daemon/src/plugin-launch.ts`: placeholders expanded, cwd (default: the plugin root) checked to stay in the plugin or its data directory, the extension's env and headers added, names made and claimed. Then each gets its own shape:

- **External runtime** (`toSessionServers`, oar's `SessionMcpServer`): the runtime does not accept a working directory, so a stdio server is started via `/bin/sh -c 'cd "$0" && exec "$@"'`; sse is skipped with a warning. This shape is locked by `apps/daemon/test/plugin-mcp-shapes.test.ts`.
- **Built-in kernel** (`toMcpEntries`, `@eta/mcp`'s `McpServerEntry`): stdio keeps its `cwd` with no wrapper; sse is taken; a remote server's `auth` is the extension's `mcp.<server>.auth`, else `"oauth"` unless an `Authorization` header is sent (from the extension, or the file). Its secrets are in the entry's `env`/`headers`, which stay in memory; see [MCP](mcp.md#configuration-sources) for what is written under `mcp/`.

The server name is `<plugin>-<server>`; invalid characters are replaced with `_`. Two servers can end up with one name (`a-b` + `c` and `a` + `b-c`, or two that differ only where `_` replaced something): in a session of an agent that has both enabled, the first in plugin-name order keeps it and the later is left out, with a warning. The settings page checks the installed plugins against each other and puts the clash in the later one's `reports`, saying it is skipped where both are enabled.

`PLUGIN_ROOT` and `PLUGIN_DATA` are set by eta and override environment variables with the same names. `PLUGIN_DATA` is at `<dataDir>/plugins/data/<name>`, retained across plugin updates, with separate copies for the main node and the daemon.

When config or files change, the session's stamp changes with it (`<name>@<content hash>:<config save time>`), and affected sessions reopen on next open.

## Other machines

When a session is opened on a daemon, `RemotePlace` first uses `machine.pluginHave` to ask which content hashes it lacks, then sends files in chunks with `machine.pluginPut` (each batch no larger than one frame, symlinks followed, anything outside the plugin root skipped); the daemon places them in `<dataDir>/plugins/store/<hash>/` only after verifying the hashes.

`machine.open` includes `plugins` (hashes and the values for each server) and `redactions`. These live only in daemon memory, are injected when the server starts, and are never written to disk. The values are sent whatever runtime the agent is on: an external runtime and eta's own loop (through the daemon's `McpHost`, see [MCP](mcp.md)) both start the servers on the daemon's machine.

## Agent reads config

`get_plugin_config({ plugin, fields? })` is a host tool that enters the realm with the tool table (`eta.platform.get_plugin_config`). It can only read plugins that this agent has enabled and that are in an enabled state.

| Level   | Used for   | Returns                                                                     |
| ------- | ---------- | --------------------------------------------------------------------------- |
| `read`  | Non-secret | Value                                                                       |
| `file`  | secret     | Path to a 0600 temporary file; the value is not included in the result      |
| `value` | secret     | Plaintext; goes into the journal and into tool records in replies           |
| `none`  | Both       | "Not readable", with a note that the plugin process has already received it |

Non-secrets default to `read`, and secrets default to `none`. The manifest declares the upper bound; users can lower it but cannot raise it.

`file` is written on the machine where the session runs (via `SshTransport`; remote goes over link), with a new 0700 directory for each read. The value goes through stdin and never enters any process's arguments. The file is deleted after one hour, and the next read on that machine also cleans up expired ones.

Every read of `file` or `value` writes an audit entry (`plugin_audit`: session, agent, plugin, field, time; the value is not recorded), visible on the settings page.

**Do not print secrets.** The result of `value` goes into the model context and journal, which the user accepts when choosing this level; scripts that need the value should read the path from `file`.

## Redaction

Before tool results and progress updates enter the model and journal, the built-in kernel replaces known secrets with `[secret <plugin>.<field>]` (`redactionMiddleware`, installed on both the main node and the daemon). The scope is all secrets saved by all plugins, except those this agent can read with `value`.

This is only a safeguard against accidents: it matches exact text, cannot catch values encoded by scripts, and ignores values shorter than 4 characters. eta cannot see or control tool output inside external runtimes.

## Market

The host reads somebody else's `marketplace.json` (the Claude Code shape, or Cursor's, which is the same) and turns an entry into the git source `{repo, rev, path}` the plugin store already has. Nothing else installs; eta has no catalog format of its own.

- Sources: setting `plugins.sources`, a list of `{url, name, enabled}` (`name` may be empty), edited in Settings → Plugins with `plugins.marketAddSource`, `marketRemoveSource` and `marketSetSourceEnabled`, and read with `marketSettings`; applied at read time, no restart. Only http(s) addresses; a duplicate is refused; an emptied list stays empty. It starts as Anthropic's list (`https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json`, on) and Cursor's (`https://raw.githubusercontent.com/cursor/plugins/HEAD/.cursor-plugin/marketplace.json`, on). A list already stored is used as it is, so an install that switched Cursor off keeps it off. A source that is off stays in the list with its address and name, is not fetched, shows no entries and no error; a new source is on, and an entry stored without `enabled` counts as on. Installed plugins do not depend on a source being on (the installed mark is by repository and path). The single address of an earlier version (`plugins.catalogUrl`) is moved into the list once: after the defaults, on; if it is one of the two defaults, that one is switched on and nothing is listed twice. The market lists every source that is on; each is read on its own, so one that fails shows its error and hides no other. With none on, the market page says so and points to the settings. The same plugin name in two sources stays twice, told apart by source; preview and install name the source.
- GitHub proxy: setting `plugins.githubProxy` (`marketSetProxy`), empty (off) by default. A prefix put in front of the whole original URL: `<prefix>https://github.com/<owner>/<repo>.git`, `<prefix>https://raw.githubusercontent.com/...`. Normalized in one place (`normalizeProxy`): trimmed, http(s) only, exactly one trailing slash; the same function runs when the URL is built. Only github.com and raw.githubusercontent.com are proxied, in the catalog fetch and in `git ls-remote` / `git fetch`, and only at the moment of the call: the stored source `{repo, rev, path}`, the source directory hash, the `.sha` record, the installed check and error messages keep the original repository (an error says a proxy was used). A relative `source` is resolved against the original raw.githubusercontent.com address before the prefix is added. `fetchInto` still requires FETCH_HEAD to equal the pinned commit, so a proxy cannot swap content. The preview shows the proxy when it applies.
- `source` of an entry: a path in the catalog's repository (relative to `metadata.pluginRoot`; only when the catalog is on raw.githubusercontent.com, which says the repository), `{source:"url", url, sha?}`, or `{source:"git-subdir", url, path, ref?, sha?}`. Any other source (`command`, `github`, none) is listed and marked unsupported (`unsupported` is set); it cannot be previewed or installed.
- Commit: a `sha` must be 40 lowercase hex digits. An entry without one has `rev: null`; the host resolves the repository's current commit once, at preview, and the install carries that hash. Preview and install use the same commit.
- Fetch: http(s) only, 1 MiB cap, 10 s timeout, at most 500 entries, per-entry checks. An invalid entry is dropped with a reason, the rest are kept. Failure or offline returns an error and leaves installed plugins alone.
- Wire (`plugins`): `marketCatalog` lists, per source, entries marked `installed` (`no`, `this`, `other`); `marketPreview {name, source}` fetches the commit into a temporary directory and returns its MCP servers, `requires`, repo, path, commit and the `reports` of the loader; `marketInstall {name, source, sha}` installs only that `sha`, and refuses it if the catalog pins another.
- No second confirmation (user decision, replacing the original "preview and explicit confirm before install" requirement): the detail dialog reads `marketPreview` when it opens and shows what the plugin at the pinned commit would run (path, commit, `requires`, skills and MCP servers with their command or URL, fixed env, header and variable names taken from the configuration, the values it will ask for, the layout, the loader's `reports`, the GitHub proxy when one is used) as plain text, and **Install installs at once**: the client calls `marketInstall` with the `sha` that preview returned (reading it first when the detail could not). Nothing at the host was relaxed: the commit is still pinned and compared, only supported sources install, catalog text is untrusted and rendered as text, logs carry no secret, and a plugin that needs values stays `needs_config` and starts nothing until they are filled in. The cost is that a wrong click, or a poisoned catalog, now installs code that runs on the machine; the detail dialog's information is what the user has to decide on. A failed install (unsupported, name taken, a command it needs missing) is shown in the dialog.
- Out of scope: publishing and automatic update.

### Cursor and Claude Code layouts

`loadPlugin` takes the manifest from `plugin.json`, else `.cursor-plugin/plugin.json`, else `.claude-plugin/plugin.json`. Both share `skills/<name>/SKILL.md` with the spec, so skills load. In those layouts skills and MCP servers load:

- no `$schema` is required, and a field of the wrong type is dropped with a report instead of rejecting the plugin (the `name` rule still rejects);
- `displayName`, `logo`, `category`, `tags` are silently ignored; `commands`, `agents`, `hooks`, `rules` and the like, and their folders, are ignored and listed in `reports`, which the detail shows;
- a `skills` path other than `skills/` is reported; only `skills/` is read. A list that only names existing `./skills/<x>` directories is not reported.
- MCP servers are read from Claude's `.mcp.json` and Cursor's root `mcp.json` (`{ "mcpServers": { ... } }`) and become the same servers the native `mcp.json` gives; there is no second launcher. `type: "http"` is `streamable-http`; `${CLAUDE_PLUGIN_ROOT}` is `${PLUGIN_ROOT}`. A `${VAR}` that is a whole env value, or inside a header, becomes a required string field (secret when its name has key, token, secret, auth, password or credential) bound to that env variable or header; the user fills it in after installing. A server is skipped, with its reason in `reports`, when it has an `auth` object (OAuth is not supported), a `${}` in its URL, a command or an argument, or text mixed with a variable in an env value. The preview lists every server (what it runs or where it connects, env and header names) and the layout the manifest was read from; nothing starts before the install is confirmed and the plugin is enabled for an agent. Once installed, the detail shows each server with its state instead. Unknown manifest fields of a Claude or Cursor plugin are not reported; the layout line is plain information (`layout`), never a warning. `plugin.json`'s `mcpServers` may be a relative path to an MCP file, a list of paths, or the servers inline; a path is checked like a `skills` path (relative, no `..`, no symlink out of the plugin), a missing file is reported, and a file also found as `.mcp.json` is read once.

## Security boundary

A stdio server runs the author's code on the machine and is not a sandbox, so before enabling it, the command it runs or the address it connects to is shown. Servers like `npx` install packages themselves at runtime, bypassing our checks.

Secrets are only passed to the server's environment, but it runs as the same user as the agent; if the agent has a shell, it can read them from `/proc/<pid>/environ`. `none` means "does not enter the context, and no way to read it is provided", not OS-level isolation.

## Request headers

Besides the headers a plugin file declares (and the ones eta fills from fields), the user can attach request headers to any remote (streamable-http or sse) MCP server of an installed plugin, for example `Authorization: Bearer <key>` or `x-api-key`. The editor is in the plugin detail, per server.

- Storage: table `plugin_header` (migration 0063), per plugin and per server, the value sealed like every other plugin secret. A secret's value is never sent back to the client, never in the preview, never logged, and is added to the redaction list so an agent cannot read it. Removing the plugin deletes its headers.
- Merge: file headers, field bindings, then user headers; on a name clash (case-insensitive) the user's wins. A header name must be an HTTP token; a value may not hold CR, LF or NUL. Headers are limited to 32 per server.
- Preview: header names the plugin file declares, never values. User headers exist only after install.
- Reach: sent only to the server's own origin. `@eta/mcp` follows redirects by hand for a server that has headers and refuses a redirect to another origin. Over plain http to a host that is not this machine, a user header is sent only once the user ticked "Allow plain http" (the loader already refuses such a url in a plugin file, so this is a second guard).
- 401: with user headers set and no declared OAuth, a 401 is reported as "credential rejected", not as a sign-in.
- A globally disabled plugin sends nothing; its headers are kept and the editor is dimmed.

## Logos

- `plugins.logo` finds a picture, in this order: the plugin's own logo (`logo` in its manifest, a path inside the plugin) -> its homepage's icon (github.com and gitlab.com homepages are skipped) -> the icon of its first remote MCP server's **parent site** (firecrawl.dev for mcp.firecrawl.dev) -> the icon of the server's own origin -> the client shows the first letter, on a colour taken from that letter. No third-party icon service is used.
- The parent site is the registrable name: the last two labels, or three when the last two are a known second-level suffix (a small fixed list such as co.uk; not the full public suffix list). A host with no more labels than that, and an IP, has no parent. Each site is probed for `<link rel="icon" | "apple-touch-icon">` in its HTML, then `/favicon.ico`. The server's configured headers and tokens are never sent; stdio servers are skipped.
- The host fetches it (`plugins/logo.ts`): public addresses only, the connection pinned to the address it checked, every redirect checked again, picture bytes only, size and time caps, cached in memory (a miss too, for a day). Market-card answers are also kept in the database (see "Caches"), so a restart does not ask again; an installed plugin's logo is memory only. An installed plugin's card asks at list time.
- **Market cards (not installed).** Neither catalog format carries a logo (Cursor entries: `name`, `source`, `description`, `minClientVersions`; Anthropic's: no `logo`/`icon` key in 317 entries). The logo is in the plugin's own manifest, so for an entry whose repository is on github.com the card asks `plugins.logo` with `{repo, ref, path}` and the host (`Logos.fromRepo`) reads `<path>/.cursor-plugin/plugin.json`, else `<path>/.claude-plugin/plugin.json`, from raw.githubusercontent.com, takes `logo` (a relative path inside the plugin; absolute, `..` and URL values are refused) and fetches `<path>/<logo>` from the same place. Nothing is cloned. Same rules as every other fetch: public addresses only, pinned connection, redirects checked, size caps (manifest 64 KB, picture 256 KB), 5 s timeout, png/jpg/webp/svg only, SVG with script or outside references refused, no credentials. At most 4 lookups run at once (host and client both queue), only for cards that are drawn; a hit is kept a day (30 days at a pinned commit), a miss an hour, in memory and in the database. Other hosts than github.com are not asked.
- Order for a market card: own logo (now also for uninstalled entries) -> homepage icon (github.com and gitlab.com skipped) -> first-letter avatar. **For Cursor entries the homepage is github.com, so the own logo is the only real source.** Anthropic entries with a relative `source` (55 of 317) use the same path; those with `url`/`git-subdir` on github.com use their pinned commit as `ref`. The ref of a relative entry is `HEAD`.
- Tests use a local fake server (`rawBase` option); the real Cursor repository is not fetched in tests.

## Environment variables (stdio)

The user can set environment variables on any stdio MCP server of an installed plugin, next to the ones its file declares. They reach that server only.

- Storage: table `plugin_env` (migration 0063), per plugin and per server, the value sealed like every other plugin secret. A secret's value is never sent back: the view carries `secret: true` and a null value, and saving with a null value keeps what is saved. Removing the plugin removes its rows.
- Merge: the file's `env` and field bindings first, then `PLUGIN_ROOT` / `PLUGIN_DATA`, then the user's. A name the plugin fixes (a non-empty value in the file, a field binding, `PLUGIN_ROOT`, `PLUGIN_DATA`) cannot be set by the user; the server view lists them as `lockedEnv` and the page shows them read-only.
- A variable the file declares with an **empty value** is a blank for the user to fill. Until each one is set, the plugin is `needs_config`: it cannot be enabled, and no server of it is started or handed to an agent. Filling it (`plugins.setEnv`) makes the plugin usable at read time; removing the row makes it unusable again.
- Checks: a name is `[A-Za-z_][A-Za-z0-9_]*`, at most 32 variables per server, a value is non-empty with no NUL and a length cap. Error messages never contain a value. Secret values are added to the redaction list, so they do not reach the model context or the journal.
- A globally disabled plugin starts nothing; its variables are kept and the editor is dimmed.

### Known limits

- **Relative-path entries use ref `HEAD`.** A catalog entry whose `source` is a directory inside the catalog's own repository has no pinned commit in the catalog, so the market asks for its logo at `HEAD`, not at a commit; the picture can change between the time it is shown and the commit an install pins. Entries on github.com with a pinned commit use that commit. (Cursor: all 155 entries are relative; Claude: 55 of 317 are relative, 262 are on github.com.)
- A logo is read from the manifest's `logo` only for `github.com` repositories; other hosts get the homepage icon or the initial.
- The market list does not carry `version` or `author` for Cursor entries (0 of 155 have them in the catalog); the detail dialog leaves out a row whose value is empty.
- Not done on purpose: plural forms in counts such as "1 prompts", an assertion of the badge colour tokens, and a test that fails before the 198.18 address change.
- `apps/eta/test/plugins.test.ts` fails on Windows (38 of 42): its fixture path comes from `new URL(...).pathname` (`/C:/...`). It fails the same way without these changes. The tests added for env, required values and logos build their fixtures in a temporary directory and run on Windows.
- Skills: eta's own loop still loads a plugin skill directory by the `name` in the file (a warning, not a skip), so the formatted name the plugin lists may differ from what that loop shows. Ignore files in a skill's directory are honoured again (a skill they ignore is skipped with a reason).
- Caches (see "Caches"): the first read of a catalog or a logo still needs the network; a catalog is re-read whenever the market opens (the kept copy shows first, source by source); expiry of a catalog copy is not time-based, it is "ask the server again, with its validator". Not confirmed (**未确认**): the time a real open takes against raw.githubusercontent.com, the number of pictures on the first frame of a packaged build, and the request counts against the real catalogs; how sqlite behaves on Windows under several host processes at once (only one connection in one process was tested). Everything above about timing was measured only with local fake servers.
- `logosCached` needs a host that has it; an older host answers with an error and the cards fall back to asking one by one. A picture only in the database for an entry whose homepage fallback was never asked is `unknown` until it is asked once.
- **Sign-in token in a header (`x-cursor-auth`).** Some servers behind a Cursor catalog answer 401 `Missing Cursor credential in x-cursor-auth` even with a valid sign-in. The test result then says "Sign-in saved; the server wants <header>" (the header name is read from the 401 text, never fixed in code) and offers two buttons: send the sign-in access token in that header as it is, or as `Bearer <token>`. This is the per-server setting `plugin_token_header` (migration 0063, `plugins.setTokenHeader`): only the header name and the format are stored; the token is read from the sign-in store on every request, so a refreshed token is used at once, and it is sent only to the server's own origin. `Authorization` cannot be chosen. The token appears in no log, preview, error text or cache key. **未确认:** which value (if any) the real Cursor server accepts. Neither format was tried against the real google-drive endpoint; if the header wants a Cursor account credential, eta does not read one from Cursor and the server stays unusable. Only google-drive was probed; the other 15 `rest-mcp` entries were not.
- **Sign in with a Cursor account (UNOFFICIAL, may stop working).** For a server on `cursor.com` that answers `Missing Cursor credential in x-cursor-auth`, the test result offers "Sign in with Cursor account" (`plugins.cursorLoginStart/Status/Cancel`, `plugins/cursor-login.ts`). The flow is what a third-party script reports, not a Cursor document: a PKCE challenge and a uuid go to `https://cursor.com/loginDeepControl` in the user's browser, and the host polls `https://api2.cursor.sh/auth/poll` (404 until confirmed) for at most 120 s. Only those two hosts, https, no redirect followed, one sign-in at a time, only on the click, never refreshed in the background. The credential (a session token of the user's Cursor account, wider than an API key) is saved as the secret header `x-cursor-auth: Bearer <token>` of that server, sealed like any secret header; `Authorization` and the service's own sign-in (Google, for google-drive) are a second, separate step. The validity left is read from the token's `exp` (not verified); after it, sign in again. The Cursor header is taken off every request that is not to the server's own origin (`ownHeadersOnly`: metadata, register, authorize, token and refresh requests never carry it). Requests to the server's own origin still carry every configured header, including a static `Authorization` (covered by `own-headers.test.ts`); only requests to other hosts lose them. **未确认:** that the real server accepts it after both steps; the user saw, with a third-party script, that the bare token is not recognised and `Bearer <token>` changes the answer to an OAuth challenge. Other headers that script sends (`x-cursor-client-type: cli` and others) are not sent; if the server turns out to need them, that is a decision for the user, not a default.
- **Where the Cursor credential is kept.** The host-level Cursor credential (`x-cursor-auth`, `PluginRows.saveCursorCredential` / `cursorCredential` in `plugins/store.ts`) is one row of the shared `credential` table (`credentials/table.ts`, sealed like the MCP and email rows): `integration = 'market'`, `key` = the source (`'cursor'`; another source takes its own key), `kind = 'secret'`, the value a string. There is no `cursor_credential` table: `0063-plugins.sql` does not make it. A database that ran the earlier plugin migrations (0061 to 0067) keeps that table with its row, unread and not moved; the user signs in to Cursor again. `configuredAt` (the stamp a session names) reads this row's `updated_at`, so saving moves it. Nothing erases the credential today, so the case of an erase moving the stamp does not arise yet. This supersedes the wording above that the credential is saved as a header of the server.
- Lint and formatting: the repository's pre-commit hook needs Node 24, which is not installed on the machine this was built on, so the hook could not run. The same tools were run by hand with bun on every file the branch changed (`eslint`, `dprint check`, `knip`); see the task report for the results. Two failures in `apps/daemon/test/plugin-launch.test.ts` (a stdio test that needs `/bin/sh`, and a symlink test) fail the same way on the merge-base.
- No screenshots, contrast measurement or real third-party sign-in were done for this work.

## Connection test

- `plugins.testServer { name, server }` connects to one server once, lists tools (names, descriptions, parameter names) and the counts of resources and prompts, and closes. It never calls a tool. It runs only on the click of "Test connection" in the plugin's Settings panel.
- It uses the same config merge a session uses (`Plugins.testPlan`: fields, then user headers) and the same `@eta/mcp` client, with a 15 s limit. Headers go only to the server's own origin.
- A plugin that is off sends nothing (`off`). A missing required value makes no connection (`needs_setup`). A server declared `oauth` is reached without a sign-in; a 401 is `needs_login`. A 401 after user headers were sent is "credential rejected". Timeout, DNS, TLS, refusal, a cross-origin redirect and a non-MCP answer each have their own message.
- Header values and tokens are masked in everything returned. A stdio server is started once by the click and stopped after it.

### Skill names

A skill name must be lowercase `a-z0-9-`, at most 64 characters, no hyphen at either end, no `--`, and equal to its directory. A plugin's skill whose name breaks the character rules is not dropped: the loader formats it (lowercase, each run of other characters becomes one `-`, trimmed, cut to 64) through `formatSkillName` and `parseSkillText(..., nameOverride)`; the harness default is unchanged. A name that formats to nothing (for example all Chinese) is skipped with a reason in `reports`. Legal names keep theirs; formatted names that clash get `-2`, `-3` in directory order, so the result does not depend on load order. Each rename is listed in `reports` as `renamed "old" -> "new"` and the skill carries `renamedFrom`. The file is not changed. Known limit: eta's own loop still loads the directory by the name in the file (a warning, not a skip), so the formatted name is what the plugin lists, not necessarily what that loop shows; and a legal name that differs from its directory is still skipped.

### The Composio source

A built-in market source (`MarketSource.kind: "composio"`, address `composio:toolkits`, `plugins/composio.ts`). It is always listed, on unless switched off with `marketSetSourceEnabled`, and cannot be removed. Its toolkits are `ComposioToolkit` (`kind: "composio"`, slug, `auth`: `api_key` | `oauth` | `none` | `unknown` from `auth_schemes`, `composio_managed_auth_schemes` and `no_auth`, categories, https logo, tools count). The source's `status` is `ready`, `needs_key` (no key: an answer, not an error), `key_rejected` (401) or `error`; only this source is affected.

- Key: `composioSetKey { key }`, `composioClearKey`, `composioStatus` (only `{ hasKey }`). Sealed with the host key in one row of the `credential` table (integration `market`, key `composio`, kind `secret`), like the Cursor credential; Composio has no migration of its own. It goes only to `https://backend.composio.dev` in `x-api-key`, redirects are refused, and it is in no cache key, log, error text or answer (a message built from a remote answer is cleaned of it).
- List: `GET /api/v3/toolkits`, 100 per page, at most 30 pages, 3000 toolkits, 2 MB and 10 s per call. The checked list (not the raw answer) is kept in `market_catalog_cache` under `composio:toolkits`; opening shows it at once, a refresh failure keeps it with `stale`. No validators are sent: the list is paged.
- Logo: `plugins.logo { composio: slug }`; the host takes the address from its own list and fetches it with the logo rules (public addresses only, redirects checked) over https only, never with the key. SVG is not accepted at all.
- Link: `composioLink { slug }` → `{ redirectUrl }` (https only). It finds the project's Composio-managed auth config for the toolkit (`GET /api/v3/auth_configs?toolkit_slug&is_composio_managed=true`) or makes one (`POST /api/v3/auth_configs`, `use_composio_managed_auth`), then `POST /api/v3/connected_accounts/link`. `user_id` is a random `eta-<uuid>` made once and kept in the settings: Composio keeps connected accounts per user id, and nothing about the person is sent.
- Not done: installing a toolkit adds no git source (`marketInstall` is untouched), and the shared MCP server is not connected.

#### API key and OAuth toolkits

`ComposioToolkit.auth` tells the card how a toolkit signs in; it changes nothing about how the link is made.

- `oauth`: the person approves on the provider's page. Composio-managed auth means Composio's own OAuth app, so no client id or secret is needed.
- `api_key`: the person gives the provider's own key on Composio's hosted page (as Composio describes it, not yet seen live). eta never receives that key.
- `none` (`no_auth`) needs no sign-in and has no account to connect, so `composioLink` refuses it (no auth-config or link request is made) and the card shows Add instead of Connect; `unknown` is shown as it is, not guessed.
- Adding a `none` toolkit: `plugins.composioAdd {slug}` → `{ status }` (`needs_key` without a key; only a slug the kept list says is `none` is accepted), `plugins.composioRemove {slug}` → `{ removed }` and `plugins.composioAdded` → `{ slugs }`. The slugs are kept in the setting `plugins.composioAdded`. An added toolkit is a plugin `@composio/<slug>` with its own checked tool_router session, like a connected one; this is the one exception to "only a connected (ACTIVE) toolkit becomes a plugin". Remove drops the slug and the kept session id, asks Composio for nothing and leaves the agents' ticks. Clearing or replacing the key drops the sessions but keeps the list. The cards say Added, not Connected, and the installed group counts both kinds. Whether Composio accepts a session for a no-auth toolkit is not verified.
- In both cases the card's install action goes straight to `redirectUrl` with no confirm dialog. The result is a connected account at Composio under the stored `user_id`; nothing is written to eta's plugin store.
- A connected toolkit can be signed in again (the same `link` as Connect; Composio's own `refresh` endpoint is deprecated and re-starts the sign-in too, so it is not used) or disconnected. `plugins.composioDisconnect {slug}` lists the ACTIVE accounts under eta's own `user_id`, then deletes those of that toolkit one by one (`DELETE /api/v3/connected_accounts/{id}`, no upstream revoke). It never deletes by slug alone and skips an account that names another user. It cannot be undone on Composio, so the client asks first. A failure returns only a status. Both buttons show in the market detail and in the installed page's Composio group, only while the key is set and the source is on. Not checked against the real service.
- The list and the icon come from `meta` of each toolkit (`meta.logo`, `meta.categories`, `meta.tools_count`). Logos are fetched by the host and cached (see Caches); the client only names a slug.

#### MCP: current state

- Composio serves all toolkits through one shared server, `https://connect.composio.dev/mcp`; there is no per-toolkit server.
- In eta, MCP servers come only from plugins. The Composio source creates no server and no plugin.
- To use it, install or write a plugin that has an `mcp.json` with that URL, and put the Composio key in a secret `${VAR}` field. The plugin Settings panel then supplies it: the request-header editor sends it to the server's own origin, and "Test connection" lists the tools without calling one.
- The key stored for the market source is not read by plugins. The plugin field is a separate entry.

#### Known limits

- Nothing here was checked against the real Composio service. Requests and answers follow its public API description and local fake servers (`apps/eta/test/composio.test.ts`). Field names, paging limits and the auth-config flow may differ.
- It is not confirmed whether the key for `https://backend.composio.dev` (the market list) is the same key the shared MCP server accepts. Treat them as possibly two keys.
- No real sign-in was done, so a link that opens, a callback and a connected account are untested.
- The `user_id` is made once per eta installation and kept in the settings; Composio's connected accounts hang on it, so it is not a person's identity.

## Caches

Both live in the host's database (migrations 0064 and 0065), behind a memory layer where there is one. Everything read back is treated as untrusted again, and the page still renders it as text.

- **Catalog** (`market_catalog_cache`, `plugins/market-cache.ts`): one row per source address as the user wrote it (a changed address is a new row; the GitHub proxy is not part of the key). It holds the JSON text, `ETag`, `Last-Modified`, when the server last confirmed it, and when it was used. `marketCatalog { mode: "cached" }` returns only what is kept, with no request; the page shows it at once with "Updated <time>", then reads again: the host sends `If-None-Match` / `If-Modified-Since`, a 304 keeps the copy and moves its time, a 200 replaces it. A failed read (network, HTTP error, bad JSON, wrong shape) keeps the old copy and returns `stale` with the reason; the error is shown only when nothing is kept. A row is checked again on read (size cap 1 MB, shape, at most 500 entries) and dropped when it fails. At most 20 rows or 8 MB; the least recently used go first. The refresh button reads again; "Clear cache" empties both caches. ("Updated" shows the oldest time among the sources shown.)
- **First frame of the market.** The page first reads the kept lists (`marketCatalog { mode: "cached" }`), then asks once for the pictures the host already has: `plugins.logosCached { entries }` (`Logos.cached`). It reads memory and the database only: no network, and it does not enter the queue of four lookups, so a stalled network cannot delay it. It does not write (not even the last-used time). Each answer is `hit` (the picture, checked again as a fresh one, an expired one too), `miss` (a recent confirmed absence) or `unknown`. Limits: at most 200 entries are looked at per call (the rest are `unknown`), and hits past about 2 MB of picture data are `unknown`; the client sends at most 200 per call. The client waits 400 ms at most: on a timeout, an error, or a host without the call, every card draws its letter at once and asks `plugins.logo` for its own picture as before, then swaps; the size of the avatar does not change. A `miss` stays a letter with no request.
- **Sources are read one by one.** `marketCatalog { source }` reads only that source. The page takes the kept lists of all sources first and then reads each source on its own; each answer replaces only its own part, so a slow or failing source holds the others back no more than it must, and a failed read leaves its kept entries on screen with their time. A kept list is never hidden because it is old (there is no time-based expiry; age only means "ask again", and the page always asks again in the background). The last list shown is also kept for the session in the page module, so the market opened again draws it on its first frame. Not done: the Composio list (`composio:toolkits`) is not changed here; it waits for #105 to merge.
- **Logos** (`plugin_icon`, `plugins/icon-cache.ts`): key repository + ref + path. A hit read at a commit (a 40-character ref) is kept 30 days, at a branch or `HEAD` one day, a confirmed absence (the repository answered 4xx other than 408/429, or the file is refused) one hour. A failure (timeout, offline, 5xx) is never stored: there is a two-minute backoff in memory, and a kept picture, even an expired one, is neither replaced nor dropped by it. On read the type is checked again (magic bytes for png/jpg/webp; an SVG must pass the same script and external-reference rules); a row that fails is deleted. At most 20 MB or 2000 rows, least recently used first. Four lookups run at once; their writes go through one connection, so they are taken one after the other.
- Measured with local fake servers (tests `market-cache.test.ts`, `plugin-icon-cache.test.ts`): after a restart a kept logo costs 0 requests (before: 2 per logo, the manifest and the picture), and opening the market costs one conditional request per source answered by 304 with no body, while the kept list shows without waiting (before: one full download, awaited).
