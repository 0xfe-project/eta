# akhook rules and streaming rules

Session behavior rules are declarative: the configuration file is the `.akhook.yml` of [akhook](https://github.com/aghub-app/akhook) (see its `docs/design.md` for the structure, reproduced here verbatim), executed by `packages/eta-plugin-akhook`, plus one kind of rule that akhook doesn't have: streaming rules (`on: stream`, from oh-my-pi's TTSR).

## Where configuration comes from

Merge order follows akhook: preset, user-level file (`<config directory>/akhook/akhook.yml`), project file (the nearest `.akhook.yml` walking up from the session's working directory), then the host's additional configuration. Later entries override earlier ones for the same ID; `disabled_rules` turns off the corresponding rules after merging. Rules from additional configuration cannot be turned off or overridden by user-level or project files — only the additional configuration itself or a later additional configuration can.

The host itself carries one layer of rules, ranked first, which user and project files can neither turn off nor override: `eta:github` (`apps/eta/src/github/akhook.ts`), where `gh-pr-create` intercepts `gh pr create` and suggests using the `open_pull_request` tool instead (see [GitHub](github.md)). This layer belongs to the GitHub chain, so it's only registered when the host loads it (`--github`, off by default): when not loaded, the agent only has `gh`, and prompting it to use a non-existent tool would be a distraction.

The host's additional configuration has three sources, in this order: the environment variable `AKHOOK_ADDITIONAL_CONFIG_PATH` (a list of paths; a missing file counts as a configuration error), `akhook.yml` in the data directory (read only if present), and text passed by the embedder via `startHost({ akhook: { additional } })`. File changes take effect on the next tool call without reopening the session.

Sessions on remote machines (daemon) read the user-level file and the project's `.akhook.yml` on the daemon's machine, then layer on the main node's additional configuration: the main node sends these layers as text on every `machine.open`, so both sides have consistent rules. `prompt_submit` / `stop` belong to a single reply and are executed by the main node's engine, so for remote projects only the user-level and additional configuration take effect (the main node cannot read the remote project directory).

## How rules are executed

| `on`                                     | Where it executes                                           |
| ---------------------------------------- | ---------------------------------------------------------- |
| `file_change`, `shell_exec`, `tool_call` | The session's `ToolMiddleware` (`before`)                   |
| `prompt_submit`, `stop`                  | The engine's `beforeRun` / `afterRun`; errors never block the agent |
| `stream`                                 | The runner's generation guard (see below); soft reminders go through `ToolMiddleware.after` |

- **Tool calls**: `deny` blocks directly; the model sees the rule ID and `message`. `ask` goes through the session's ask channel, so it appears as a card in the pending page — no one-time authorization file from akhook for Codex is needed, so `ask_instruction` has no place to act (the field is still parsed but has no effect). `decide` runs an external command to decide. If the same call has `deny`, it's rejected; otherwise if it has `ask`, it asks. If the configuration can't be read, the checker errors, or `ast` can't infer the language, the call is rejected — never allowed through.
- **eta's tools**: every call is a `tool_call` candidate; `bash` (with `command` argument) is also `shell_exec`, and `shell_tools` can add more; `edit` / `write` are also `file_change`, where the rule only looks at content introduced by this change: `regex` looks at added lines, `ast` only counts matches not already in the old content.
- **Matching implementation**: `argv` uses tree-sitter-bash (wasm) to split the command into simple commands (lists, pipelines, subshells, command substitutions, `sh -c`); `ast` uses `@ast-grep/napi` (built-in js/ts/tsx; rust, go, python, bash, json, yaml use `@ast-grep/lang-*`). `regex` is JavaScript regex; leading `(?i)`, `(?m)`, `(?s)` are translated into flags.
- **Approval list unified with `ask` rules**: tools in the list count as an extra `ask` hit in the same middleware, so when a call is required to confirm by both rules and the list, it only asks once, with the rule wording in the prompt. The list remains a user setting (`inbox.setApprovals`), read fresh on each call. Daemon sessions ask the main node for the list via `tool.gate`, also going through the same middleware (the previous separate `approvalMiddleware` on each side has been removed).

## Streaming rules (`on: stream`)

```yaml
rules:
  - id: no-fixme
    on: stream
    scope: [
      text,
      "tool:edit(*.ts)",
      "tool:write(*.ts)",
    ] # default text and all tools, excluding thinking
    checks:
      - regex: "FIXME"
      - ast: {
          language: tsx,
          pattern: "const $A: any = $B",
        } # only check after a tool call is complete
    paths: ["src/**"] # optional: extra gate on file paths
    interrupt_mode: always # always | prose-only | tool-only | never, default always
    repeat_mode: once # once | after-gap, default once
    repeat_gap: 10 # with after-gap, how many completed turns between
    message: rule body, used as a reminder
```

Fields correspond to omp's `condition` (`regex`), `astCondition` (`ast`), `scope`, `globs` (`paths`), `interruptMode`, `repeatMode`, `repeatGap`. Matching is applied to accumulated output during generation, so it spans stream fragments; for `edit` / `write` what matches is the new content they write, and for other tools it's the JSON of the arguments.

When hit and interruption is required: this generation is stopped, the already-generated portion is discarded, the rule body is injected as a user message, and regeneration happens in the same turn. `never` (and `prose-only` / `tool-only` when encountering the other kind of output) is a soft reminder: the tool executes normally, and the reminder is appended to its own tool result (for hits in text and thinking, appended to the next tool result; if there's no tool result this round, it's dropped and doesn't count as a trigger).

Trigger records (which rule fired at which completed turn, and the count of completed turns) are stored in the session's value store (`akhook.stream`), and counting continues after reopening the session.

`presets: [omp]` provides omp's 27 rules, sourced from a copy in the akhook repo (`presets/omp/*.md`, MIT), embedded into `src/omp-preset.gen.ts` by `bun run embed` (the daemon is a single file and can't read the package directory at runtime). akhook maps them to pre-execution denials; here they are `stream` rules, preserving omp's original `interruptMode: never`, i.e. soft reminders.

## kernel primitives

`eta-core`'s runner gains "interrupt the current generation, discard the generated part, inject a message, generate again":

- `RunnerOptions.guardGeneration` / `runner.addGenerationGuard(guard)`: the guard is called once per stream frame, and returning `GenerationInterrupt { reason, source?, inject? }` means interrupt. Guards are asked in the order they were added; the first interrupt takes effect. Each turn accepts at most `maxInterrupts` (default 8) interrupts, after which guards are no longer asked.
- How an interrupt works: this request has its own `AbortSignal` (interrupting cancels only this request, not the run's signal), the partial output is discarded, the `inject` message enters the transcript and journal as a normal message, then the context is reassembled and generation restarts; it does not consume a retry and does not open a new turn.
- Event `generation:interrupted` (`runId`, `turnId`, `reason`, `source`, which interrupt it was, discarded characters and usage, how many messages were injected). The UI must drop the half-streamed message when it sees this.
- journal gets a new `interrupt` entry: who, why, how much was discarded; the discarded text never appears in the journal, transcript, or the next request. It is not a transcript message and has no corresponding system line.
