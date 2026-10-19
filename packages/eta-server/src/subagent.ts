/**
 * What a subagent *is*, on this server: a session of its own.
 *
 * The pool (`@eta/harness`) owns the semantics — slots for top-level agents only, a
 * depth cap of two, ownership, usage rolling up, notes picked up at a boundary. What
 * it deliberately leaves open is the runner, and this file answers it: a child is a
 * real session, opened through the same `SessionManager` as any other, so
 * "spawn an agent" costs nothing new to explain — it is a session in the sidebar,
 * with its own journal, its own budget, and its own transcript to open and read.
 *
 * Three details are load-bearing:
 *
 * - **The child inherits what the parent was left on**: its cwd, its persona, the agent and
 *   conversation it works for, and (unless the spec names one) its model. `openSession` does the rest.
 * - **The child's own pool knows whose child it is.** The runner passes its record id as
 *   the child's `subagentOwner`, so a grandchild is filed under it — a nested subagent
 *   cannot reach across the tree, and the depth cap counts real depth instead of
 *   restarting at one every generation.
 * - **Stopping is a poll, not a signal.** The pool mutates the record this runner was
 *   handed; a child that has been stopped is seen between turns (and aborted), which is
 *   the same boundary a steering note is picked up at.
 */
import type {
  SubagentApi,
  SubagentManager,
  SubagentRecord,
  SubagentRunner,
  SubagentUsage,
} from "@eta/harness";
import type { ManagedSession, SessionManager } from "./manager";
import type { SessionMeta } from "./store";

export interface SessionSubagentOptions {
  /** The session whose children these are: what a child inherits, and where it runs. */
  parent: SessionMeta;
  manager: SessionManager;
  /**
   * The pool this session's children are filed in. It exists only once the session does
   * (the pool is built during assembly), so the runner reads it when it runs — by then it
   * is there, or the session could not have spawned anything.
   */
  parentPool: () => SubagentManager | undefined;
  /** Diagnostics for a child that could not be opened, or a flush that failed. */
  warn?: ((message: string) => void) | undefined;
}

/** The runner a session's pool uses: each child is a session, run to its end. */
export function sessionSubagentRunner(
  options: SessionSubagentOptions,
): SubagentRunner {
  return async (record, api) => await runChild(options, record, api);
}

async function runChild(
  options: SessionSubagentOptions,
  record: SubagentRecord,
  api: SubagentApi,
): Promise<SubagentUsage> {
  const parentMeta = options.parent;
  const pool = options.parentPool();
  if (pool === undefined)
    throw new Error("this session has no subagent pool to file a child under");
  const child = await options.manager.create({
    cwd: parentMeta.cwd,
    title: `subagent ${record.id}: ${firstLine(record.spec.prompt)}`,
    ...(parentMeta.persona === undefined
      ? {}
      : { persona: parentMeta.persona }),
    // Whose work this is: a child's requests are counted for the agent and conversation that
    // spawned it, and a host that routes by either sees the child as part of the same work.
    ...(parentMeta.agentId === undefined
      ? {}
      : { agentId: parentMeta.agentId }),
    ...(parentMeta.conversationId === undefined
      ? {}
      : { conversationId: parentMeta.conversationId }),
    ...(record.spec.model === undefined && parentMeta.model === undefined
      ? {}
      : { model: record.spec.model ?? parentMeta.model }),
    // The child joins the pool it was spawned into, and acts as its own record there: its
    // children are filed under *it*, which is what keeps nesting depth real and reach local.
    subagents: pool,
    subagentOwner: record.id,
  });
  try {
    return await runOne(child, record, api);
  } finally {
    // The child stays open, and its journal is flushed: a subagent is a session, so its
    // transcript is evidence that has to survive a crash, and closing it is the user's
    // move (`sessions.delete`) rather than something that happens behind their back.
    await child.session.journaling.flush().catch((error: unknown) => {
      options.warn?.(
        `[eta-server] could not flush subagent ${child.meta.id}: ${String(error)}`,
      );
    });
  }
}

/** Queue the task as a run, watch its turns, and let it end. */
async function runOne(
  child: ManagedSession,
  record: SubagentRecord,
  api: SubagentApi,
): Promise<SubagentUsage> {
  const session = child.session;
  const ctx = session.kernel.ctx as unknown as {
    on: (name: string, listener: (payload: unknown) => void) => () => boolean;
  };
  const before = session.journaling.usage;
  let status: "completed" | "failed" | "aborted" = "completed";
  let error: string | undefined;

  // Stopping is read from the record, which the pool mutates: a boundary check catches the
  // ordinary case, and this poll catches a child that is stuck *inside* a turn — a provider
  // that never answers would otherwise be unkillable.
  const aTurnEnded = (): void => {
    api.reportTurn(record.id);
    // A note is picked up at a boundary, exactly like a steering message.
    for (const note of api.pendingNotes(record.id)) session.kernel.steer(note);
    // The pool mutates the record it handed us; being stopped is read here.
    if (record.status === "stopped") session.runner.abort();
  };
  const watch = setInterval(() => {
    if (record.status === "stopped") session.runner.abort();
  }, 250);
  (watch as { unref?: () => void }).unref?.();

  const ended = new Promise<void>((resolve) => {
    ctx.on("turn:end", aTurnEnded);
    ctx.on("turn:run-end", (payload) => {
      const end = payload as {
        status: "completed" | "failed" | "aborted";
        error?: string;
      };
      status = end.status;
      error = end.error;
      resolve();
    });
  });

  if (record.status === "stopped") {
    clearInterval(watch);
    return { input: 0, output: 0 };
  }
  session.kernel.nextRun(record.spec.prompt);
  session.pump.pump();
  await ended;
  clearInterval(watch);

  const after = session.journaling.usage;
  const usage: SubagentUsage = {
    input: Math.max(0, after.input - before.input),
    output: Math.max(0, after.output - before.output),
  };
  if (status !== "completed") {
    // A child that failed is a failed child: the pool records the spend either way, but
    // the status has to say so — a "done" subagent that produced nothing is a lie.
    throw new SubagentFailed(
      status,
      error ?? `the child ${child.meta.id} ${status}`,
    );
  }
  return usage;
}

/** A child's run that did not complete. The pool settles the record as failed. */
export class SubagentFailed extends Error {
  readonly status: "failed" | "aborted";

  constructor(status: "failed" | "aborted", message: string) {
    super(message);
    this.status = status;
    this.name = "SubagentFailed";
  }
}

/** A title from a task: the first line, cut short enough to read in a sidebar. */
function firstLine(prompt: string): string {
  const line = prompt.split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}
