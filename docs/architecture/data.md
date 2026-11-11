# Data

Product data lives in SQLite (`bun:sqlite`); sessions are stored as files, as upstream does. Everything lives in **one data directory**: `$HOME/.eta`, not a switch. For a different location, change `HOME`; in the Docker image `HOME=/data` and the volume is mounted at `/data`, so contents live in `/data/.eta/`, owned by the non-root user `bun` (uid 1000), which is what the host and session bash run as.

No second root is allowed here. There used to be a `--data-dir`: it only moved config, database, and sessions, while persona cards were still read from the real `~/.eta/persona`, so a process started with a different directory looked like "the model config is gone". Once user-level things like persona and MCP config also follow `$HOME`, one root is enough.

## Directory layout

```text
<data directory>/
  eta.sqlite(-wal, -shm)    product database
  config.json               upstream settings (models, providers, etc.; maintained by the providers plugin)
  llm/                      state of the LLM gateway: auths/ credentials, models.json, config.yaml (CPA's config, including the Gemini key)
  unpacked/<name>-<content hash>/   files for the packaged host, unpacked on first use: cpa-…/ (CLIProxyAPI and cpa-launcher), daemon-…/ (the build for machines). Delete them and they are unpacked again; directories from old versions are cleaned up automatically
  sessions/<session id>/       upstream sessions: meta.json + journal.jsonl (sessions on this host machine)
  attachments/<conversation id>/    files users attach to messages: <attachment id>-<file name> (in-progress uploads are .up-<id>, cleaned up on restart)
  agents/<agent id>/       the agent's workspace (it is also a project)
  routines/<routine id>/   the working directory for each routine run
  worktrees/<project id>/task-<number>/   the task's git worktree on primary (kept after the run; on daemon machines it is in ~/.eta/worktrees/)
  artifacts/<artifact id>/<version>/   archive.zip and the unpacked files/; artifacts/.preview-key is the signing key for preview URLs
  plugins/<directory>/      Agent Plugins (with plugin.json, see [plugins](plugins.md)) and eta-server user plugins (package.json contains eta-plugin); the two are recognized separately
  plugins/data/<plugin name>/    the plugin's PLUGIN_DATA, preserved across updates
  plugin-sources/           plugins fetched from git, pinned to a commit
  plugin-runtime/           generated directory for Claude Code, containing only valid skills (symlinks)
  modules/                  official plugins
  access-token              the token for the token gate (when enabled; 0600)
  secret.key                sealing key for email, MCP, and GitHub (0600, generated on first use)
  github/                   GitHub login for git and gh on this host machine (tokens last at most an hour, see [GitHub](github.md)): gh/hosts.yml, token, login, git/github.inc
```

daemon data lives in the same root: `~/.eta/daemon/` (see [machines and daemon](machines.md)), GitHub login in `daemon/github/`, sessions in `daemon/sessions/`. It shares `$HOME` with the host, each occupying its own subdirectory. The memory sidecar's data lives in its own PostgreSQL, not here.

## SQLite

`src/db.ts`: WAL, foreign keys, `busy_timeout`. All times are epoch milliseconds.

**Migrations** are a flat numbered sequence `apps/eta/src/migrations/NNNN-<name>.sql`, run in numeric order, with applied ones recorded in `eta_migrations`. Malformed filenames or duplicate numbers error out rather than being silently skipped. A new feature that needs a table takes the next number; two branches claiming the same number conflict at merge time instead of corrupting someone's data. The database is not the contract — the wire protocol is — so the schema can change as long as there is a migration.

| 0001 agents | `agent` |
| 0002 machines | `machine` (`primary`, `daemon`, `ssh`; status online/offline/pending/revoked) |
| 0003 projects | `project` (unique on machine + path) |
| 0004 conversations | `conversation`、`participant`、`message` |
| 0005 interactions | `interaction` (questions asked in a session and their results) |
| 0006 settings | `setting` (key + JSON, e.g. the approval list) |
| 0007 usage | `usage` |
| 0008 | `message` gains two row kinds, `task_draft` and `task_card` |
| 0009 tasks | `task` (number via AUTOINCREMENT, never reused), `task_activity` |
| 0010 artifacts | `artifact`、`artifact_version`、`artifact_share` |
| 0011–0013 | `routine`, `routine_run` (at most one run per routine at a time, guaranteed by a unique index), `routine_feedback`, `routine_brief` (brief versions) |
| 0014 | `machine_enrollment` (one-time enrollment codes, digest only) |
| 0028 | `attachment` (attachments: which conversation they belong to, name, type, size, which message claimed them; unsent ones are cleaned up after 24 hours) |
| 0033 | `credential` (credentials for external integrations: `integration`, `key`, `kind`, encrypted `value`; currently the OAuth state of MCP servers, see [MCP](mcp.md)) |
| 0034 | `task_run` (a task's run, which is also the queue); `task` gains project, workspace (mode, worktree path and branch), and source conversation, and drops `assignee`; `machine.max_active_runs` (default 2); `task_activity` gains run-type entries, see [Tasks](tasks.md) |
| 0035 | `github_app`, `github_user` (private key, client secret, and user tokens sealed), `github_pending` (in-flight manifests and authorizations), `task_pull` (PRs delivered by tasks), see [GitHub](github.md) |
| 0046 captain | Captain：`agent.system_role`、`message.author = 'captain'`、assignment/target、task provenance |
| 0047 captain-reviews | Captain review queue: failed, stuck, Inbox, and assignment events awaiting review, recording the dedupe key, checkpoint, delivered message, and Captain reply |
| 0048 run-activity | run's `last_event_at/error_code/retryable`; Captain review's `attempts/next_attempt_at` backoff fields |
| 0049 captain-inbox | Captain inbox relay |
| 0043 | `plugin_source` (git source), `plugin_config` (config, sealed), `plugin_agent_level` (levels the user lowered), `agent_plugin` (which plugins an agent has enabled, deleted with the agent), `plugin_audit` (records of agents reading secrets, without values), see [Plugins](plugins.md) |
| 0032 | `bundle_config` (environment bundle config, encrypted), `bundle_source` (bundles from git: repository, rev, path, resolved commit), `agent.bundles` (bundles an agent loads, as a JSON list) |
| 0039 | `task.assignee_agent` (optional executing agent; null falls back to the creator), `task.base_branch`, see [Tasks](tasks.md) |
| 0041 | Captain: `agent.system_role`, `message.author = 'captain'`, assignment/target, task provenance, prompt/settings versions, memory pause, operations/notifications/retry, see [Captain](captain.md) |
| 0042 | Captain review queue: failed, stuck, Inbox, and assignment events awaiting review, recording the dedupe key, checkpoint, delivered message, and Captain reply, see [Captain](captain.md) |

Foreign key trade-off: the columns pointing at agents and conversations in `message.agent_id`, `interaction`, and `usage` have **no** foreign keys, because those rows are history and outlive the agent.

## Session files

Each session (the upstream `FileSessionStore`) gets its own directory: `meta.json` (cwd, model, etc.) and `journal.jsonl` (an append-only log, compacted on load). Session contents are not copied into SQLite; SQLite holds only the `participant.session_id` pointer. After a restart the host finds sessions again via `participant`, and the new process reads the same files.

For sessions on a remote machine, the files live in the daemon data directory on **that machine**; the primary stores only a pointer (which machine a session belongs to is decided by the machine of the project its conversation is in).

## Startup cleanup

A restarted process assumes "everything the previous process had in flight is gone": `failInterrupted` marks leftover queued/working replies as failed, `expirePending` expires unanswered questions, routine runs still `running` are marked failed, task runs still `starting/running` are marked failed, and daemons that were online are first marked offline until they reconnect.
