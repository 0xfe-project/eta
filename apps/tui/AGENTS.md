# Terminal interface (apps/tui)

The `eta` command: a host client drawn with React 19 and Ink 8 on the terminal's alternate screen. Its parts, connection, settings files, screens and extension interface are in [`docs/architecture/tui.md`](../../docs/architecture/tui.md); the commands are in [`docs/tui/commands.md`](../../docs/tui/commands.md).

Guideline: **do not copy the desktop app**. Show one thing at a time; bring up anything else on demand and put it away when done. Completeness is the desktop app's job. Be no more intrusive than the desktop app: no automatic layers, no bell, no terminal notifications.

## Conventions

- Data goes only over the wire, like the web UI: the one WebSocket in `src/connection/wire.ts`, subscribing to targets and calling `target.action`. Types come from `@eta/client-contracts`. **Before starting, read `docs/architecture/` and the implementation of the same feature in `apps/web/src`**, keep the semantics the same, and do not invent ops. When the host lacks an interface, change the host instead of working around it in the TUI.
- Do not touch `~/.eta`. Finding a host, starting and stopping processes and writing settings all live in `src/connection/`, which hands over only structured results and produces no text for people; the UI only reads the controller's state and calls its actions.
- Add a feature by adding files only: a module under `src/ext/` default-exports an `Extension`, and `scripts/gen-extensions.ts` generates the registry, with no changes to existing files.
- Command and argument names are English only, with no aliases. After adding or changing a command, run `bun run --cwd apps/tui docs` to regenerate the command docs, or the tests fail.
- UI text uses `defineMessages({ en, zh })`, with the English and Chinese keys in one-to-one correspondence and the same placeholders; the `catalog-parity` test guards this. Product names, command names and code stay as they are.
- When using Ink's `useInput` directly, put `useInputActive()` into `isActive`; bind keys by action name with `useAction`, so keybindings can be changed in the settings instead of being hard-coded.
- Wrap async actions started from layer callbacks, key handlers and screens in `ctx.reportFailure(promise)`, so a failure is reported in the status area instead of an unhandled rejection crashing the program.
- Colours come only from the theme (`useTheme()`, passed through `inkColor` before reaching Ink); no hard-coded colour codes.

## Tests

- Test the connection layer and commands against a **real host**: `test/support/host.ts` starts an in-process host on a free port in a temporary directory. Core paths are not tested against stand-ins.
- Test the UI with Ink's test renderer, asserting on screen text and key behaviour; helpers are in `test/ui-support/`.
- Always use temporary directories (`test/support/temp.ts`) and never touch the real `~/.eta`; tests make no requests to the outside network, and anything needing a model or a sign-in endpoint points at a local address.

## Commands

```sh
bun run --cwd apps/tui dev             # run from source
bun run --cwd apps/tui test
bun run --cwd apps/tui typecheck
bun run --cwd apps/tui docs            # regenerate docs/tui/commands*.md
bun run --cwd apps/tui build:binaries  # cross-compile into apps/tui/out/
```
