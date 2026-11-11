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
- `mcp.<server>.env` and `headers` pass fields to the server; they are not written into `mcp.json`. `mcp.json` stays as the spec requires: `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded once, and nothing else is expanded. Multi-select fields are joined with commas. Fields without a value do not set this variable or add this header.
- `requires` is informational only: checked per machine, and anything missing is shown on the settings page.

There is one global configuration; it is `seal`ed into one JSON object and stored in `plugin_config`. Secrets are not returned over the wire; leaving blank means unchanged, and `null` means clear. The host refuses to save values that do not match the fields; missing required items can still be saved, with the state remaining pending configuration.

## Status

`Needs configuration` (`needs_config`) / `Ready` (`ready`). Missing required fields, saved values that do not match the current fields, or an invalid `config` all mean the plugin needs configuration. Only ready plugins can be selected.

When config is no longer valid after an upgrade, fall back to pending configuration: enabled agents remain checked, sessions skip it, and both the settings page and agent editor show a notice. It recovers automatically once fixed.

## What a session gets

| Runtime             | Skill                                                                                        | MCP                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Built-in kernel     | Directory wired into `skillDirsFor`, included in the skills block of the system prompt       | Not started in this version; marked in the UI; picked up by the next task |
| Claude Code         | `--plugin-dir` natively loads a generated directory containing only valid skills             | oar's `mcpServers`                                                        |
| Codex, OpenCode, Pi | Name, description, and path written into the system prompt; the agent reads the files itself | oar's `mcpServers`                                                        |

Claude Code cannot use the plugin directory directly: `--plugin-dir` treats it as a Claude plugin, runs its `hooks/`, and loads its `commands/`, which eta does not support. The generated directory is at `<dataDir>/plugin-runtime/claude/<content hash>/<plugin name>/skills/`, containing symlinks to valid skills.

The runtime does not accept a working directory, so the stdio server is started via `/bin/sh -c 'cd "$0" && exec "$@"'`, with cwd defaulting to the plugin root. The server name is `<plugin>-<server>`; invalid characters are replaced with `_`.

`PLUGIN_ROOT` and `PLUGIN_DATA` are set by eta and override environment variables with the same names. `PLUGIN_DATA` is at `<dataDir>/plugins/data/<name>`, retained across plugin updates, with separate copies for the main node and the daemon.

When config or files change, the session's stamp changes with it (`<name>@<content hash>:<config save time>`), and affected sessions reopen on next open.

## Other machines

When a session is opened on a daemon, `RemotePlace` first uses `machine.pluginHave` to ask which content hashes it lacks, then sends files in chunks with `machine.pluginPut` (each batch no larger than one frame, symlinks followed, anything outside the plugin root skipped); the daemon places them in `<dataDir>/plugins/store/<hash>/` only after verifying the hashes.

`machine.open` includes `plugins` (hashes and the values for each server) and `redactions`. These live only in daemon memory, are injected when the server starts, and are never written to disk. Sessions with the built-in kernel do not start MCP, so no server values are sent, but `redactions` still contains secrets.

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

## Security boundary

A stdio server runs the author's code on the machine and is not a sandbox, so before enabling it, the command it runs or the address it connects to is shown. Servers like `npx` install packages themselves at runtime, bypassing our checks.

Secrets are only passed to the server's environment, but it runs as the same user as the agent; if the agent has a shell, it can read them from `/proc/<pid>/environ`. `none` means "does not enter the context, and no way to read it is provided", not OS-level isolation.
