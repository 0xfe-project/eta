/**
 * Subagents — a pool of children, ported from eta-agent's `harness/subagent.ts`.
 *
 * The semantics are the interesting part, and each one is here because the
 * obvious alternative deadlocks or leaks:
 *
 * - **Only top-level agents take a pool slot.** A nested child does not, because
 *   its parent is already holding one and is waiting for it: queueing a child
 *   behind its own waiting parent is a guaranteed deadlock.
 * - **Depth is capped (2), width is not.** A cap on nesting is a cap on
 *   confusion; a cap on how many siblings can run would be a cap on the work.
 * - **You only control your own children.** `stop`/`steer` by anyone but the
 *   parent (or the child itself) is an error, not a silent no-op: an agent that
 *   can reach across the tree is an agent whose failures cannot be explained.
 * - **A parent's terminal state stops its descendants.** Nothing is orphaned
 *   when the thing that was going to read its answer is gone.
 * - **Usage rolls up the chain**, so a parent's bill includes what it spent on
 *   its children.
 * - **Notes are picked up at a boundary**, not injected mid-turn: a child is
 *   steered the way a run is steered, between turns.
 *
 * What a child *is* — a session, a request, an in-process call — is not this
 * file's business: `SubagentRunner` is the seam, and the server supplies the real
 * one. That is what lets the pool be tested without a session manager existing
 * yet.
 */
import type { SubagentEvents } from "@eta/core";

export interface SubagentUsage {
  input: number;
  output: number;
}

/** What a child is asked to do. */
export interface SubagentSpec {
  prompt: string;
  model?: string | undefined;
  maxTurns?: number | undefined;
}

export type SubagentStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "stopped";

export interface SubagentRecord {
  id: string;
  parentId: string | undefined;
  depth: number;
  /** Whether this spawn is waiting for its answer right now. */
  blocking: boolean;
  status: SubagentStatus;
  /** What this agent itself spent. */
  usage: SubagentUsage;
  /** This agent plus everything under it. */
  totalUsage: SubagentUsage;
  spec: SubagentSpec;
  turns: number;
  children: string[];
  /** Steering notes waiting for the child's next boundary. */
  notes: string[];
}

export type SubagentEventName =
  | "subagents:completed"
  | "subagents:failed"
  | "subagents:steered";

/** Where the pool announces what it did; the session's bus is the usual answer. */
export interface SubagentBus {
  emit(
    type: SubagentEventName,
    payload: SubagentEvents[SubagentEventName],
  ): void;
}

/** What a running child is handed: report turns, take notes. */
export interface SubagentApi {
  reportTurn(recordId: string): void;
  /** Take (and clear) the steering notes waiting for this child. */
  pendingNotes(recordId: string): string[];
}

/** How one child actually runs. The server supplies the real one. */
export type SubagentRunner = (
  record: SubagentRecord,
  api: SubagentApi,
) => Promise<SubagentUsage>;

export const DEPTH_CAP = 2;
export const DEFAULT_POOL_SIZE = 10;

const NO_USAGE: SubagentUsage = { input: 0, output: 0 };

/** Whether a status is an end state: nothing more will happen to this record. */
function isTerminal(status: SubagentStatus): boolean {
  return status === "done" || status === "failed" || status === "stopped";
}

export class SubagentManager {
  private readonly records = new Map<string, SubagentRecord>();
  private readonly bus: SubagentBus;
  private readonly runner: SubagentRunner;
  /** Callers waiting for a record to reach a terminal state. */
  private readonly waiters = new Map<
    string,
    ((record: SubagentRecord) => void)[]
  >();
  private sequence = 0;
  private running = 0;
  readonly poolSize: number;

  constructor(
    bus: SubagentBus,
    runner: SubagentRunner,
    poolSize = DEFAULT_POOL_SIZE,
  ) {
    this.bus = bus;
    this.runner = runner;
    this.poolSize = poolSize;
  }

  /** Spawn a child; `blocking` means the parent waits for its answer. */
  spawn(
    spec: SubagentSpec,
    parentId?: string,
    blocking = false,
  ): SubagentRecord {
    const parent =
      parentId === undefined ? undefined : this.records.get(parentId);
    if (parentId !== undefined && parent === undefined)
      throw new Error(`unknown parent ${parentId}`);
    const depth = parent === undefined ? 1 : parent.depth + 1;
    if (depth > DEPTH_CAP) throw new Error(`depth cap ${DEPTH_CAP} exceeded`);
    this.sequence += 1;
    const record: SubagentRecord = {
      id: `sub-${this.sequence}`,
      parentId,
      depth,
      blocking,
      status: "queued",
      usage: { ...NO_USAGE },
      totalUsage: { ...NO_USAGE },
      spec,
      turns: 0,
      children: [],
      notes: [],
    };
    this.records.set(record.id, record);
    parent?.children.push(record.id);
    this.pump();
    return record;
  }

  /** Spawn a child the parent will wait for. */
  spawnAndWait(spec: SubagentSpec, parentId?: string): SubagentRecord {
    return this.spawn(spec, parentId, true);
  }

  get(id: string): SubagentRecord | undefined {
    return this.records.get(id);
  }

  list(): SubagentRecord[] {
    return [...this.records.values()];
  }

  /** How many children are running right now (the pool's own bookkeeping). */
  get runningCount(): number {
    return this.running;
  }

  /**
   * Wait for a record to reach a terminal state (or return at once if it is
   * already there). Thinking is nobody's but the caller's, so every form of
   * settling — done, failed, stopped — resolves it.
   */
  async wait(id: string): Promise<SubagentRecord | undefined> {
    const record = this.records.get(id);
    if (record === undefined || isTerminal(record.status)) return record;
    return await new Promise<SubagentRecord>((resolve) => {
      const waiting = this.waiters.get(id) ?? [];
      waiting.push(resolve);
      this.waiters.set(id, waiting);
    });
  }

  /** A child reports a finished turn; the turn budget is enforced here, not by the child. */
  reportTurn(id: string): void {
    const record = this.records.get(id);
    if (record === undefined) return;
    record.turns += 1;
    const max = record.spec.maxTurns;
    if (
      max !== undefined &&
      record.turns >= max &&
      record.status === "running"
    ) {
      this.stop(id, id);
    }
  }

  /** Queue a steering note for a live child; ownership enforced like stop. */
  steer(id: string, byId: string | undefined, note: string): boolean {
    const record = this.records.get(id);
    if (
      record === undefined ||
      (record.status !== "running" && record.status !== "queued")
    )
      return false;
    if (byId !== undefined && byId !== id && record.parentId !== byId)
      return false;
    record.notes.push(note);
    this.bus.emit("subagents:steered", {
      id: record.id,
      parentId: record.parentId,
      note,
    });
    return true;
  }

  /** Take the notes waiting for a child: what its next boundary will read. */
  pendingNotes(id: string): string[] {
    const record = this.records.get(id);
    if (record === undefined) return [];
    const notes = [...record.notes];
    record.notes = [];
    return notes;
  }

  /** Stop a child (and, with it, its descendants). Only its own parent may. */
  stop(id: string, byId: string | undefined): void {
    const record = this.records.get(id);
    if (record === undefined) throw new Error(`unknown agent ${id}`);
    if (byId !== undefined && byId !== id && record.parentId !== byId) {
      throw new Error(
        `not your child: ${id} owned by ${String(record.parentId)}`,
      );
    }
    if (record.status === "running" || record.status === "queued") {
      this.release(record);
      this.finish(record, "stopped", record.usage);
    }
  }

  /** A child settled on its own: record what it cost and what became of it. */
  settle(id: string, usage: SubagentUsage, failed = false): void {
    const record = this.records.get(id);
    if (record === undefined || record.status !== "running") return;
    this.release(record);
    this.finish(record, failed ? "failed" : "done", usage);
  }

  /** Mark a record and everything it was responsible for. */
  private finish(
    record: SubagentRecord,
    status: SubagentStatus,
    usage: SubagentUsage,
  ): void {
    record.status = status;
    record.usage = usage;
    record.totalUsage = {
      input: record.totalUsage.input + usage.input,
      output: record.totalUsage.output + usage.output,
    };
    // What a child spent is what its parent spent on it, all the way up.
    let node: SubagentRecord | undefined = record;
    while (node !== undefined) {
      const parent: SubagentRecord | undefined =
        node.parentId === undefined
          ? undefined
          : this.records.get(node.parentId);
      if (parent === undefined) break;
      parent.totalUsage = {
        input: parent.totalUsage.input + node.totalUsage.input,
        output: parent.totalUsage.output + node.totalUsage.output,
      };
      node = parent;
    }
    this.bus.emit(
      status === "done" ? "subagents:completed" : "subagents:failed",
      {
        id: record.id,
        parentId: record.parentId,
      },
    );
    for (const resolve of this.waiters.get(record.id) ?? []) resolve(record);
    this.waiters.delete(record.id);
    // Nothing is orphaned: a terminal parent takes its descendants with it.
    if (status === "done" || status === "failed" || status === "stopped") {
      for (const childId of record.children) {
        const child = this.records.get(childId);
        if (
          child !== undefined &&
          (child.status === "running" || child.status === "queued")
        ) {
          this.stop(childId, record.id);
        }
      }
    }
    this.pump();
  }

  private release(record: SubagentRecord): void {
    if (record.status !== "running") return;
    // Only top-level agents ever took a slot, so only they give one back.
    if (record.parentId === undefined) this.running -= 1;
  }

  private pump(): void {
    for (const record of this.records.values()) {
      if (record.status !== "queued") continue;
      const nested = record.parentId !== undefined;
      if (!nested && this.running >= this.poolSize) continue;
      record.status = "running";
      if (!nested) this.running += 1;
      void Promise.resolve(
        this.runner(record, {
          reportTurn: (id) => this.reportTurn(id),
          pendingNotes: (id) => this.pendingNotes(id),
        }),
      )
        .then((usage) => this.settle(record.id, usage))
        .catch(() => this.settle(record.id, record.usage, true));
    }
  }
}
