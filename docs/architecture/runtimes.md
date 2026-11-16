# External runtimes

A session runs on eta's own loop unless its metadata names a `runtime`. Then the session host asks
its runtimes for that one, and the session's runs are handed to it: the session stays an eta
session (journal, bus, inbox, a place in every list), and the runtime is what answers.

## The seam

`packages/eta-server/src/runtimes.ts`. A host is given `SessionRuntimes`: `open(input)` answers a
`SessionRuntime` (`models`, `delegate`, optional `compact`, `dispose`) or `undefined` for "not
mine". `composeRuntimes([...])` makes several sets one: each is asked in turn, and the catalog
(`catalog.list(fresh)`, what `agents.runtimes` returns) is every set's, one after another.

What a runtime is handed (`SessionRuntimeInput`), beyond the session's id and directory:

- `resume`, `remember`: the runtime's own session id, kept in `SessionMeta.runtimeSession`.
- `agentPrompt()`, `hostTools()`: read when the runtime opens, after the session's tools exist.
- `mcpServers`, `launchArgs`: what the agent's plugins bring.
- `wake`: for a runtime that begins a turn nobody asked for.
- `ask`: the session's ask channel, bound once the session exists. A question asked through it is
  an ordinary question of the session's: it shows in the Inbox and is answered the same way, on
  the primary and on a daemon alike.
- `settings`: opaque values from `RuntimeExtras.settings`.

A session on an external runtime gets the host's tool middleware (`toolMiddleware`), like any
other: the approval list on the primary and redaction on a daemon hold when the runtime calls one
of the host's tools.

Two adapters implement the seam, and `apps/eta/src/host.ts` and `apps/daemon/src/node.ts` compose
them:

| Package            | Runtime ids                         | Reached through                            |
| ------------------ | ----------------------------------- | ------------------------------------------ |
| `@eta/runtime-oar` | `claude`, `codex`, `opencode`, `pi` | `@botiverse/oar`                           |
| `@eta/runtime-acp` | `acp.<id>`                          | `@agentclientprotocol/sdk` (ACP v1), stdio |

## ACP agents

Every agent in `~/.eta/acp.json` (`{ "agents": AcpAgentConfig[] }`, types in
`packages/client-contracts/src/acp.ts`) is a runtime `acp.<id>`. There are no presets: the list is
the file. The `acp` wire target edits it (`list`, `save`, `delete`, `test`).

The file may be edited by hand, and `save` and `delete` rewrite it whole, so a file that is there
but cannot be read whole is an error, never an empty or shorter list. That covers a file that
cannot be read, is not JSON (a trailing comma included), does not hold `{ "agents": [...] }`, lists
an id twice, or has **any single agent that does not pass the checks**: that one agent fails the
whole file rather than being skipped, because a skipped agent would be dropped by the next write.
While the file is in that state, `acp.list` carries the error (it names the file and the reason)
instead of a list, the settings page shows it and offers no edits, `save` and `delete` are refused
without writing a byte, and no `acp.<id>` runtime is listed. A missing file is an empty list.

`save` writes the file and returns at once, with the agent as last known; an agent nobody has
looked at yet says `Checking…` in its `detail`. The look (`initialize` and an empty session, up to
twenty seconds each) runs behind and arrives as the next `acp.list`. `test` still waits for its
answer.

One eta session is one agent process (a stdio child of the host, or of the daemon the session is
on) and one ACP session in it, started at the first run and kept until the session closes.

| ACP                              | eta                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `initialize`                     | At every process start. eta declares `fs` and `terminal` as off: an agent uses its own file and shell access.                                                                              |
| `session/new`                    | First run. `cwd` is the session's directory; `mcpServers` is eta's own tools (an HTTP server on 127.0.0.1 named `eta`) and the plugins' servers; `systemPrompt` where the agent takes one. |
| `session/resume`, `session/load` | A session that has run before: resume where the agent can, load (its replay dropped) where it only can that, a new session otherwise, and whenever the agent no longer has the old one.    |
| `session/prompt`                 | One prompt at a time. What is sent while the agent answers is queued and becomes the next prompt of the same run: the protocol has no steer.                                               |
| `session/update`                 | Folded into eta turns: chunks into an assistant message, `tool_call` / `tool_call_update` into a call and its result (`details.acp` keeps the kind, locations and diffs).                  |
| `session/cancel`                 | Stopping the run. Pending permission requests are answered `cancelled`; an agent that does not end its turn in ten seconds loses its process.                                              |
| `session/request_permission`     | Asked of the user through `ask` (`questionId` `acp-permission:<toolCallId>`), unless the agent is configured `autoAllow`, which picks `allow_once`. No answer is a rejection, never a yes. |
| `session/set_config_option`      | The session's model and thinking level, where the agent lists a `model` / `thought_level` option. An agent that lists none runs on its default.                                            |
| `authenticate`                   | Not called. An agent that wants a sign-in is `unauthenticated`, and is signed in from a terminal on its machine.                                                                           |

A process that died is replaced at the next run, which picks the agent's session up again.

On a daemon, what runs is what that machine's own `~/.eta/acp.json` lists: the agent process runs
where the session is, and so does its configuration. The `acp` wire target edits the primary's
file only; an id the session's machine does not list fails the run with
`the ACP agent <id> is not configured on this machine`.

Not there yet: `/compact` (the protocol has no client-side compaction), agent modes, per-agent
permission rules, a permission card that shows a diff, and killing a whole process tree on Windows.
