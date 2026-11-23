<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# ETA agent rules

## A Computer Use process is never killed without the user

A realm's app (Blender, an editor, a browser with a half-filled form) may hold work nobody saved.
Ending that process destroys it, so:

- Never terminate an app that Computer Use launched, and never kill the `powershell.exe` worker or
  `eta-hidden-desktop-*.ps1` behind a realm, not even "to clean up". `Stop-Process`, `taskkill`,
  `TerminateProcess` and friends are all out of bounds for these processes.
- `computer_close` releases the realm — desktop handle, bookkeeping — and deliberately leaves the
  app running. Report that instead of looking for a way to end it.
- Only the user ends one, by pressing Close on the panel and confirming the warning it shows.
- When a launch comes back with `"<target>" is already open in realm "<id>"`, ask the user to close
  that window if they want the new one. Never close it for them.
