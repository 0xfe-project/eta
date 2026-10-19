/**
 * ToolService — the tool seam (REFACTOR.md §2.2).
 *
 * Plugins register tools here; the runner reads the current set every turn,
 * so hot registration/unregistration never disturbs a running turn. A
 * middleware chain stands between the runner and execution: `before` can
 * observe, rewrite arguments, or block a call; `after` can observe or rewrite
 * the result. This is the replacement for pi's before/after_tool_call hooks.
 *
 * The registry is deliberately unconstrained about tool shape (eta-agent
 * lesson: harness tool types with extra required fields must fit here); a
 * tool is anything with a name and an execute function.
 */

import type { Context } from "cordis";
import type { ToolExecution } from "../types/config";
import { Service } from "cordis";
import { AbortRequested, cancellationOf } from "./effect-gate";

/** The minimal tool shape the seam requires. Plugin tools may carry more. */
export interface KernelTool<TArgs = unknown, TResult = unknown> {
  name: string;
  description?: string;
  // A method, not a property: its parameters are checked bivariantly, which is
  // what lets `KernelTool<{ path: string }>` be stored as `KernelTool`.
  // eslint-disable-next-line ts/method-signature-style
  execute(args: TArgs, call: ToolCallInfo): TResult | Promise<TResult>;
}

/** What the runner knows about a call when it asks the middleware chain. */
export interface ToolCallInfo {
  turn: number;
  toolCallId: string;
  /** Aborts when the run is cancelled; long-running tools should watch it. */
  signal?: AbortSignal;
  /** What the tool sees about its environment, resolved at request time. */
  toolContext?: unknown;
  /**
   * Report progress mid-call. Updates are only accepted while the call is
   * running: once it settles (or fails, or is cancelled) they are dropped, so
   * a tool that keeps streaming cannot publish into a finished call
   * (eta-agent's acceptingUpdates rule).
   *
   * `options.checkpoint` marks an update a client should persist rather than
   * treat as a frame to drop — a long command's output at a moment worth
   * keeping.
   */
  update?: (partial: unknown, options?: ToolUpdateOptions) => void;
}

/** What a tool says about one progress update beyond the partial itself. */
export interface ToolUpdateOptions {
  /** A point a consumer may keep: not a transient frame. */
  checkpoint?: boolean;
}

export type BeforeToolResult =
  | { ok: true; args: unknown }
  | { ok: false; blockReason: string };

export interface ToolMiddleware {
  name: string;
  /** Runs outermost-to-innermost; the last write wins per field. */
  before?: (
    name: string,
    args: unknown,
    call: ToolCallInfo,
  ) => BeforeToolResult | Promise<BeforeToolResult>;
  /** Runs innermost-to-outermost on the way back. */
  after?: (
    name: string,
    args: unknown,
    result: unknown,
    call: ToolCallInfo,
  ) => unknown | Promise<unknown>;
}

/** The result a call reports when the run was cancelled before it could complete. */
const ABORTED_TOOL_RESULT = {
  isError: true,
  content: "Tool execution was cancelled before completion.",
};

/** Whether an error is the run being cancelled rather than a tool failing. */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { name?: string }).name === "AbortError";
}

export class ToolService extends Service {
  static readonly provide = "tools";

  private tools = new Map<string, KernelTool>();
  private middlewares: ToolMiddleware[] = [];

  constructor(ctx: Context) {
    super(ctx, "tools");
  }

  /** Register or replace a tool. Returns an unregister function. */
  register(tool: KernelTool): () => void {
    this.tools.set(tool.name, tool);
    return () => {
      // Only unregister if it is still the same tool (no clobber on re-register).
      if (this.tools.get(tool.name) === tool) this.tools.delete(tool.name);
    };
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): KernelTool | undefined {
    return this.tools.get(name);
  }

  /** The set the runner hands to the provider this turn. */
  list(): KernelTool[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Append a middleware layer; returns a detach function. */
  use(middleware: ToolMiddleware): () => void {
    this.middlewares.push(middleware);
    return () => {
      const i = this.middlewares.indexOf(middleware);
      if (i >= 0) this.middlewares.splice(i, 1);
    };
  }

  /**
   * Execute a batch of calls the way the session is configured (eta-agent's
   * runSequential/runParallel). Results always come back in call order, so the
   * transcript reads the same either way; parallel only changes when the work
   * happens, never what order it is recorded in.
   */
  async executeBatch(
    calls: readonly { id: string; name: string; arguments: unknown }[],
    options: {
      execution: ToolExecution;
      turn: number;
      signal?: AbortSignal;
      toolContext?: unknown;
      /** Effect admission: a cancelled run stops starting new tool calls. */
      admit?: <T>(work: () => T) => T;
      /** Lets the caller wait for effects that already started. */
      track?: <T>(work: Promise<T>) => Promise<T>;
      /** Receives a running tool's progress; called only while it runs. */
      onUpdate?: (
        call: { id: string; name: string },
        partial: unknown,
        options?: ToolUpdateOptions,
      ) => void;
    },
  ): Promise<{ id: string; result: unknown }[]> {
    const run = async (call: {
      id: string;
      name: string;
      arguments: unknown;
    }) => {
      const admit = options.admit ?? (<T>(work: () => T) => work());
      // The call owns its update channel: open while it runs, closed the moment
      // it settles, whichever way that happens.
      let accepting = true;
      const onUpdate = options.onUpdate;
      try {
        const admitted = admit(() =>
          this.execute(call.name, call.arguments, {
            turn: options.turn,
            toolCallId: call.id,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.toolContext === undefined
              ? {}
              : { toolContext: options.toolContext }),
            ...(onUpdate === undefined
              ? {}
              : {
                  update: (
                    partial: unknown,
                    updateOptions?: ToolUpdateOptions,
                  ) => {
                    if (accepting)
                      onUpdate(
                        { id: call.id, name: call.name },
                        partial,
                        updateOptions,
                      );
                  },
                }),
          }),
        );
        const tracked =
          options.track === undefined ? admitted : options.track(admitted);
        return await tracked;
      } catch (error) {
        // Not admitted, or cancelled while it ran: the run is stopping, and the
        // call reports that rather than a failure of its own.
        if (error instanceof AbortRequested) return ABORTED_TOOL_RESULT;
        throw error;
      } finally {
        accepting = false;
      }
    };
    if (options.execution === "sequential") {
      const results: { id: string; result: unknown }[] = [];
      for (const call of calls)
        results.push({ id: call.id, result: await run(call) });
      return results;
    }
    const settled = await Promise.all(calls.map(run));
    return calls.map((call, index) => ({
      id: call.id,
      result: settled[index],
    }));
  }

  /** Execute a call through the full chain: before (outer→inner) → tool → after (inner→outer). */
  async execute(
    name: string,
    args: unknown,
    call: ToolCallInfo,
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      return { isError: true, content: `unknown tool: ${name}` };
    }
    let currentArgs = args;
    for (const m of this.middlewares) {
      if (m.before === undefined) continue;
      const verdict = await m.before(name, currentArgs, call);
      if (!verdict.ok)
        return {
          isError: true,
          content: `blocked by ${m.name}: ${verdict.blockReason}`,
        };
      currentArgs = verdict.args;
    }
    let result: unknown;
    try {
      result = await tool.execute(currentArgs, call);
    } catch (error) {
      // An abort is not a tool outcome — it stops the run. Everything else a
      // tool throws is a result the model has to read (eta-agent's
      // executeToolCall converts the same way).
      if (isAbortError(error)) throw error;
      // The run was cancelled while this call ran: whatever the tool ended with
      // on the way out is that cancellation, not a tool failure — judged by the
      // call's own signal, never by what the error says.
      const cancelled = cancellationOf(call.signal);
      if (cancelled !== undefined) throw cancelled;
      return {
        isError: true,
        content: error instanceof Error ? error.message : String(error),
      };
    }
    for (const m of [...this.middlewares].reverse()) {
      if (m.after === undefined) continue;
      result = await m.after(name, currentArgs, result, call);
    }
    return result;
  }
}
