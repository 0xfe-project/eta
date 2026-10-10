---
name: agenvo
description: Native control of the coding runtimes (Paseo, Herdr) on the user's remote computers through agenvo. Use when the user wants to look at or drive agents, workspaces, worktrees or terminals on one of their computers directly — list them, start an agent, send it input, read what it did, interrupt it, answer its questions — rather than hand over work as a task.
---

# agenvo

The `agenvo` MCP server is the user's [agenvo](https://github.com/Xuanwo/agenvo)
relay, which the user's remote computers are connected to. AXP signs in
for you; you never need or see a credential. It has agenvo's own two
tools:

- `search` finds runtimes and their native methods.
- `execute` runs a JavaScript function body in which
  `await call({deviceId, instanceId}, method, params)` calls one native
  method on one runtime and returns its outcome.

Methods and their parameters are the runtime's own (Paseo's, Herdr's);
`search` is always the source of truth for what exists. Work with native
IDs: never guess one, read it from a result. Paths, files and processes are
the remote computer's: your own shell and files are not on it, so check
them through native calls, not locally.

Work handed over to be done and reported on belongs on the task board
(the tasks plugin). This is for direct, fine-grained operation; a native
call is not a task and does not need one.

## Find the runtime

```json
{ "query": "" }
```

lists every runtime: `deviceId`, `instanceId` (`paseo` or `herdr`), `kind`,
`online`, `available`, `connectorVersion` and the owner's free-form
`context` (read it: where repositories live, conventions). `deviceLabel` is
`axp:<computer id>:<runtime>`; the computer's name is in the tasks plugin's
`list_assignees`. An offline device (`online: false`) or unavailable runtime
cannot be called; say so instead of retrying.

Then find methods by keywords and get the schema of the ones you will
call, narrowed to the target:

```json
{
  "query": "paseo.agents",
  "deviceId": "…",
  "instanceId": "paseo",
  "includeSchema": true
}
```

## Call

`execute` takes a function body; `call` returns
`{execution, requestId, result, nativeIds?, error?}`:

| `execution`   | Meaning                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| `accepted`    | The runtime took the call. For input this means submitted, not done: read state to know what happened.          |
| `rejected`    | The runtime refused it: read `error.code` (`not_found`, `unsupported_capability`, …).                           |
| `not_started` | Nothing happened: the device is offline (`device_offline`), the runtime unavailable, or the params are invalid. |
| `starting`    | Accepted and still initializing (a Herdr agent starting): read its state later.                                 |
| `unknown`     | It may or may not have happened (`timeout`, lost connection): check native state before anything else.          |

Whatever `execution` says, an `error` means there is no `result` to use. A
read whose answer is over 64 KiB comes back with `error.code`
`result_too_large`: ask for less.

Rules:

- **Return small things.** Return the fields you need, not whole results:
  IDs, statuses, the lines you will read. A tool result over 64 KiB is
  refused whole (`result_too_large`), and so is one native call's result.
- **One write per execute, and return its receipt**: `execution`,
  `requestId`, `error` and the native IDs it created or touched.
- **Never repeat a write blindly.** After `unknown`, a failed script
  (`isError`, with "Dispatched calls" receipts) or a failed tool call (the
  relay unreachable, a timeout on your side), read native state first:
  does the agent or workspace exist, did the input arrive (it is in the
  history)? Then decide. Report `unknown` as unknown.
- **Keep native errors.** Return `error` whole: besides `code` and
  `message` it may carry `native`, the runtime's own error (Herdr's
  `workspace_create_failed`, say). Report them as they are, not your
  paraphrase.
- **Don't wait inside execute.** There is no `sleep`; scripts stop after 30
  seconds. Submit, return, wait on your side (a shell `sleep`), then read in
  a new execute. Variables don't survive between executes.
- Events (`events/*`) are not available through AXP; read state instead.

## Paseo

| Do                      | Method                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Workspaces              | `paseo.workspaces.list`, `paseo.workspaces.create` (`source`: a directory or a new worktree off a project), `paseo.workspaces.archive`   |
| Agents                  | `paseo.agents.list` (`page` for paging, `filter`), `paseo.agents.get` (status and pending questions)                                     |
| Start an agent          | `paseo.agents.create` (`provider` codex or claude, `cwd`, `workspaceId`): no prompt is sent                                              |
| Input, follow-ups       | `paseo.agents.send` (`text`, `activeTurnBehavior`, `messageId`)                                                                          |
| Read what it did        | `paseo.agents.history` (`limit` ≤ 50, `direction`, `cursor`)                                                                             |
| Interrupt, answer, stop | `paseo.agents.cancel`, `paseo.interactions.respond` (`requestId` from `paseo.agents.get`), `paseo.agents.archive`, `paseo.agents.resume` |
| Providers               | `paseo.providers.list`, `.models`, `.modes`                                                                                              |

- `paseo.agents.send` **interrupts** the agent's current turn by default
  (`activeTurnBehavior: "interrupt"`). To add to running work without
  stopping it, pass `"steer"`; check `paseo.agents.get` first. Pass your
  own `messageId` (a UUID) so that after `unknown` you can look for it in
  the history instead of sending again.
- History: start with the newest few (`limit` 5–20, `direction:
  "before"`, no cursor); the page has `entries` (oldest first),
  `startCursor` and `hasOlder`. For the page before it, pass that
  `startCursor` back as `cursor`. Return only what you need of each entry
  (its `item.type` and text), not the raw page. If a page is
  `result_too_large`, halve `limit` and read the same page again; if one
  entry alone is too large, say so — don't skip it or guess a cursor past
  it. `staleCursor` or `reset` means the timeline was rebuilt: old cursors
  are void, start again from the newest.
- `paseo.agents.archive` and `paseo.workspaces.archive` stop the agent;
  archiving a worktree workspace can delete its uncommitted files.
- No terminals through agenvo for Paseo.

## Herdr

Herdr runs agents as terminal programs in panes. `session.list` finds its
sessions; most calls take the `session`. Workspaces (`workspace.*`),
worktrees (`worktree.list/create/open/remove`), tabs (`tab.create/close`),
panes (`pane.list/get/read/run/send-text/send-keys`) and agents
(`agent.list/get/start/prompt/read/send-keys`).

- `agent.start` needs an existing pane (open one with `tab.create` or
  `workspace.create`), returns `starting`; read `agent.get` until it runs.
  Pass the provider's own arguments for full access if the work needs it
  (the instance `context` may say which).
- Output is a terminal snapshot: `agent.read`/`pane.read` with `lines`
  (default 80; keep it small). If the default `source` comes back empty,
  read `source: "visible"` — there is no structured history, request IDs
  or cursors. Answer questions with `agent.prompt`/`agent.send-keys` after
  reading the screen.
- Interrupt is a key (`agent.send-keys` with `esc`, or `ctrl+c` in a
  shell).
- Names and IDs can be reused after Herdr restarts: read state again when
  identity matters.

## Agents that are working on a task

A task assigned to a remote agent has a native agent AXP drives. The tasks
plugin's `get_task` lists them under `sessions`: `device_id` and
`instance_id` (the `call` target), `workspace`, and `native` IDs (Paseo
`agent_id`, `workspace_id`; Herdr `session`, `name`, `workspace_id`,
`tab_id`, `pane_id`). An `open` session is the task's current one.

- Reading it (status, history, screen) is fine.
- To have it do something, comment on the task (`comment_task`): AXP sends
  the comment as a follow-up and tracks the reply. Don't send it input,
  cancel, archive or close it yourself unless the user asks; AXP would lose
  track of the run, and archiving stops it.
- Don't touch agents, workspaces or panes you did not create unless the
  user asks: they may be the user's own work in progress.

## Report

Tell the user what you did with the native IDs (workspace, agent, message,
pane) and each outcome: accepted, rejected (with its code), or unknown and
what you checked. If you created something only to try it out, offer to
archive or close it.
