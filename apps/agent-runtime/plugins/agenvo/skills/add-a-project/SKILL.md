---
name: add-a-project
description: Clone a repository on a user's remote computer and register or open it in Paseo or Herdr using a plain terminal, without starting a coding agent.
---

# Add a project

Use agenvo `search` and `execute` to work on the requested computer. Discover
its instances, read their context, and retrieve the relevant method schemas.
All paths and commands belong to that computer. Do not substitute another
computer when a runtime is unavailable.

## Find a terminal and destination

- Read existing projects/workspaces to learn the owner's directory conventions.
  If none are useful, open a home workspace and a plain shell. Determine the
  actual home directory from instance context or native state; do not assume a
  username or OS. Inspect likely development directories before choosing one.
- Paseo: use `paseo.workspaces.create` for a directory workspace, then
  `paseo.terminals.create`. Herdr: discover a live `session`, then use
  `workspace.create` or `tab.create`; retain the returned pane ID. Neither
  path requires creating an Agent. Use a terminal you created for this work;
  do not send shell commands into somebody else's active pane.
- Discover capabilities before calling them. A Paseo client having a terminal
  UI does not guarantee its connector exposes terminal methods. If Paseo lacks
  them, a Herdr terminal on the same computer can perform the clone. If neither
  provides a usable terminal, report the missing capability instead of starting
  an Agent to work around it.

## Clone and verify

Check the destination before cloning. If it exists, inspect its Git remote and
working state; reuse a matching checkout, or choose another destination. Never
overwrite it. Clone the requested repository with properly shell-quoted URL
and path, using the machine's existing authentication. Do not paste credentials
into commands or invent another credential source.

Submit with Paseo `paseo.terminals.run` or Herdr `pane.run`, then read output
in a separate call. Input confirmation does not prove completion. Check the
clone's exit result and inspect the resulting checkout and remote URL before
registration. After an uncertain write, inspect the terminal and filesystem
before repeating it.

Read narrowly: Herdr `pane.read` accepts `lines`; Paseo `paseo.terminals.read`
uses native capture offsets. Captures include blank screen rows, so a tail
full of blanks is not proof nothing ran. Inspect a bounded visible range,
then adjust using the returned capture information. Reduce ranges after
`result_too_large`; do not retry an identical oversized read.

## Register and open

- Paseo: `paseo.projects.add` registers the checkout by `cwd`. Verify its path
  and ID with `paseo.projects.list`, then open a directory workspace referencing
  the returned project ID if one is not already open. Creating a workspace
  alone is not proof of project registration. If the connector lacks project
  registration, report that gap rather than claiming it succeeded.
- Herdr: open the checkout using `workspace.create` and verify it with
  `workspace.list`/`workspace.get`. Herdr's workspace model is not Paseo's
  project catalog; describe what was actually created.

Report the checkout path, Git remote and native project/workspace IDs. Leave
the new project available. Close only setup terminals you created when no
longer needed, after preserving their output; do not archive a project
workspace as setup cleanup.
