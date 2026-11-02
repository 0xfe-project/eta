/**
 * RunDelegate — a run the session hands to someone else.
 *
 * The runner's loop is one way to take a run: generate, execute the tool calls, feed the results
 * back. An external agent runtime (Claude Code, Codex, ...) is another: it owns its own loop, its
 * own tools and its own context, and the session only hears what it did. A delegate is how such a
 * runtime takes the session's runs without the session becoming something else.
 *
 * What stays the runner's, delegated or not: the run's lifecycle on the bus (`turn:run-start`,
 * `turn:run-failed`, `turn:run-end`), what opens a run (the inbox it accepts and journals), the
 * abort, and the durability wait at the end. So everything that watches a session (the pump, the
 * journal, a panel, a host waiting for the reply) sees a delegated run exactly as it sees its own.
 *
 * What the delegate owns: the turns in between. It reports them in the kernel's vocabulary
 * (`turn:start`/`turn:end`, `message:*`, `tool:*`) on the emit it is handed, and puts messages in
 * the transcript through `push`, which is what the journal writes down.
 */
import type { KernelConfig } from "../types/config";
import type { Emit } from "../types/events";
import type { AgentMessage } from "../types/messages";
import type { KernelTool, ToolCallInfo } from "./tools";

export interface RunDelegateContext {
  readonly runId: string;
  /**
   * What opened this run: the inbox items the runner accepted. They are already in the
   * transcript and the journal; the delegate hands them to its runtime.
   */
  readonly opening: readonly AgentMessage[];
  /** Aborts when the run is cancelled; the delegate stops its runtime's turn and answers `aborted`. */
  readonly signal: AbortSignal;
  /** The session's bus, checked against the kernel's vocabulary. */
  readonly emit: Emit;
  /** Count one turn the runtime took (one model step); false once the turn budget is spent. */
  noteTurn: () => boolean;
  /** Add a message to the transcript and the journal, exactly like one the loop produced. */
  push: (message: AgentMessage) => void;
  /**
   * Take what the inbox holds for a boundary: steering always, follow-ups when `followUps` (the
   * runtime would otherwise stop). What is taken is adopted into the transcript and the journal.
   */
  take: (options: { followUps: boolean }) => AgentMessage[];
  /** Hear an input queued while the run is in flight. Returns the function that stops it. */
  onInput: (listener: () => void) => () => void;
  /** The session's configuration now: the model and thinking level are read live. */
  config: () => KernelConfig;
  /** The session's tools, as they are registered now. */
  tools: () => readonly KernelTool[];
  /** Run one of the session's tools through its middleware chain, under this run's signal. */
  executeTool: (
    name: string,
    args: unknown,
    call: { toolCallId: string; update?: ToolCallInfo["update"] },
  ) => Promise<unknown>;
}

export interface DelegatedRunResult {
  status: "completed" | "failed" | "aborted";
  /** What went wrong, when the run failed. */
  error?: string;
}

export interface RunDelegate {
  run: (context: RunDelegateContext) => Promise<DelegatedRunResult>;
}
