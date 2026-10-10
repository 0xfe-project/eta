---
name: agenvo
description: Direct control of the coding runtimes (Paseo, Herdr) on the user's remote computers through agenvo. Use when the user wants to look at or drive agents, workspaces, worktrees or terminals on one of their computers themselves — list them, start an agent, send it input, read what it did, interrupt it — rather than hand work over as a task.
---

# agenvo

The `agenvo` tools are the user's [agenvo](https://github.com/Xuanwo/agenvo)
relay, which their remote computers are connected to; AXP signs in for you.
Follow the tools' own descriptions: `search` finds runtimes and native
methods (`includeSchema` for parameters), `execute` runs a script of
`call(target, method, params)`.

- `search` with an empty query lists the runtimes. A `deviceLabel` of
  `axp:<computer id>:<runtime>` is that computer's Paseo or Herdr (names in
  the tasks plugin's `list_assignees`). Read the owner's `context`.
- Paths, files and processes are the remote computer's, not your shell's.
- Use native IDs from results; never guess one.
- Return only what you need from a script: a native result over 64 KiB is
  refused (`result_too_large`). Read history and terminals narrowly: Paseo
  `paseo.agents.history` with a small `limit` and its `startCursor` for
  older pages (halve `limit` when too large; never skip an entry); Herdr
  `pane.read`/`agent.read` with few `lines`.
- After `unknown`, or a script or tool call that failed, check the native
  state before repeating a write. `accepted` input is not finished work.
- Pass on `error` as it is, including `native`.
- `paseo.agents.send` interrupts the current turn unless
  `activeTurnBehavior` is `steer`.

Task-board work stays with the tasks plugin; a native call needs no task.
Agents working on a task are driven by AXP: to have one do something,
comment on the task. Don't send to, cancel or archive them, or touch what
you did not create, unless the user asks. Tell the user the native IDs of
what you created and each outcome.
