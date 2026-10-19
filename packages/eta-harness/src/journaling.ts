/**
 * JournalingService — durability as a subscriber (REFACTOR.md §3 ruling 6,
 * §K5).
 *
 * The journal's owner: one service per session writes the entries, the usage
 * rows, and the session state, and everyone else asks it. The kernel is not in
 * this business — it counts nothing and writes nothing; the runner hands it a
 * `journal` seam so a finished run can be a durable run, and that is the whole
 * of the kernel's interest in storage.
 *
 * The runner emits what happened; this service writes it down. Same session,
 * same order (cordis dispatches synchronously), but the runner never waits for
 * the disk: a per-turn commit is started when the turn ends and lands while the
 * next turn is already running. One exception is deliberate — the run boundary
 * awaits `flush()`, so "the run finished" means "the run is durable".
 *
 * What it writes:
 * - `message:end`      → the message becomes an entry, then `entry:added`.
 * - `turn:end`         → the usage row for that turn's assistant message, then
 *                        the commit that holds both, then `usage:recorded`.
 * - `compaction:end`   → the compaction entry (the service's payload carries it).
 * - `turn:run-failed`  → one `run_failed` entry, staged ahead of the run
 *                        boundary's flush, so a failed run ends durable.
 * - `generation:interrupted` → one `interrupt` entry (the discarded output is not kept).
 * - `turn:run-end`     → whatever is still staged.
 *
 * The entry ids live here now, which is why `message:end` carries no entryId:
 * an id exists once it has been written, and `entry:added` is where a consumer
 * learns it.
 */

import type {
  AgentMessage,
  ConfigService,
  Emit,
  KernelConfig,
  StoredTask,
  TaskService,
} from "@eta/core";
import type {
  AnswerEntry,
  AnswerPayload,
  AskEntry,
  AskPayload,
  BtwEntry,
  CommitOutcome,
  Entry,
  InterruptEntry,
  MessageEntry,
  NewEntry,
  RunFailedEntry,
  SessionLog,
} from "@eta/core/session";
import type { JsonValue, Usage, UsageRow, ValueWrite } from "@eta/core/storage";
import type { Context } from "cordis";
import { kernelEmit, kernelOn } from "@eta/core";
import { emptyUsage, setValue, value } from "@eta/core/storage";
import { Service } from "cordis";

/**
 * The session's configuration, as a value. Namespaced outside `pi.*` on purpose:
 * that range belonged to the old journal's lanes and operations, and an importer
 * is right to skip it.
 */
export const SESSION_CONFIG = value<KernelConfig>("eta.session.config");

/**
 * The task ledger, as a value — the same namespace eta-agent wrote, so an old
 * session's tasks load into this one.
 */
export const TASKS_STATE = value<StoredTask[]>("eta.tasks.state");

export interface JournalingServiceOptions {
  /** The log this session writes to. Without one, nothing is persisted. */
  journal?: SessionLog;
  /** Watched for configuration changes to persist. */
  config?: ConfigService;
  /** Watched for task changes to persist. */
  tasks?: TaskService;
  /** Called when a commit fails; the run continues (the next commit retries). */
  warn?: (message: string) => void;
}

let usageCounter = 0;

/** A usage row id, unique within a session journal. */
let payloadCounter = 0;

function payloadEntryId(): string {
  payloadCounter += 1;
  return `entry-${payloadCounter.toString(36)}-${Date.now().toString(36)}`;
}

let btwCounter = 0;

function btwId(): string {
  btwCounter += 1;
  return `btw-entry-${btwCounter.toString(36)}-${Date.now().toString(36)}`;
}

function usageId(): string {
  usageCounter += 1;
  return `usage-${usageCounter.toString(36)}-${Date.now().toString(36)}`;
}

let runFailedCounter = 0;

function runFailedId(): string {
  runFailedCounter += 1;
  return `run-failed-${runFailedCounter.toString(36)}-${Date.now().toString(36)}`;
}

let interruptCounter = 0;

function interruptId(): string {
  interruptCounter += 1;
  return `interrupt-${interruptCounter.toString(36)}-${Date.now().toString(36)}`;
}

let compactionCounter = 0;

function compactionId(): string {
  compactionCounter += 1;
  return `compaction-${compactionCounter.toString(36)}-${Date.now().toString(36)}`;
}

export class JournalingService extends Service {
  static readonly provide = "journaling";

  readonly log: SessionLog | undefined;
  /** The configuration the journal last heard about. */
  private readonly config: ConfigService | undefined;
  /** The task ledger the journal last heard about. */
  private readonly tasks: TaskService | undefined;
  private readonly warn: (message: string) => void;
  private readonly emit: Emit;
  /** The entry each just-recorded message landed on, keyed by the message object. */
  private readonly entryOf = new WeakMap<object, MessageEntry>();
  /** Serializes commits so the journal order is the event order. */
  private tail: Promise<unknown> = Promise.resolve();
  /** Bumped when the journal gains an *entry*: the transcript's change signature. */
  private entryVersion = 0;
  /** How many compactions this branch has been through. */
  private compactionEpochValue = 0;
  /** The last totals the journal heard, mirrored so a view can read them synchronously. */
  private usageTotals: Usage = emptyUsage();
  /** KV keys this session has written (the state panel's list, read without I/O). */
  /**
   * The keys written, *by namespace*. The journal writes values for its own bookkeeping
   * (the session config, the branch tip) as well as for whoever used the value store, and a
   * panel that lists "the state" wants the latter — so keeping the namespace is what lets
   * the question be asked precisely.
   */
  private readonly valueKeys = new Map<string, Set<string>>();
  /** Runs whose failure is already an entry: one failed run, one record. */
  private readonly failedRuns = new Set<string>();
  private readonly offs: (() => boolean)[] = [];

  constructor(ctx: Context, options: JournalingServiceOptions = {}) {
    super(ctx, "journaling");
    this.log = options.journal;
    this.config = options.config;
    this.tasks = options.tasks;
    this.warn = options.warn ?? (() => undefined);
    this.emit = kernelEmit(ctx);
    const on = kernelOn(ctx);
    this.offs.push(
      on("message:end", (event) => {
        this.record(event.message, event.terminate === true);
        void this.enqueueCommit();
      }),
      on("turn:end", (event) => {
        // The usage row rides in the commit of the message it was spent on.
        this.recordUsageFor(event.message, event.usage);
        void this.enqueueCommit();
      }),
      on("compaction:end", (event) => {
        if (event.status !== "completed") return;
        this.recordCompaction(event);
      }),
      on("turn:run-failed", (event) => {
        // Staged only: the runner's flush, which follows, is the commit that lands it.
        this.recordRunFailure(event.runId, event.error);
      }),
      on("generation:interrupted", (event) => {
        this.recordInterrupt(event);
      }),
      on("turn:run-end", () => {
        void this.enqueueCommit();
      }),
      // Session state that outlives the process: the configuration a session
      // was left on, and the ledger it was working through. Both are written
      // whole (last write wins), so a reload cannot read a half-applied state.
      on("state:config-update", () => {
        this.persistConfig();
      }),
      on("task:created", () => {
        this.persistTasks();
      }),
      on("task:updated", () => {
        this.persistTasks();
      }),
      on("task:removed", () => {
        this.persistTasks();
      }),
    );
  }

  /** Write the whole configuration, so a reload comes back on the same one. */
  private persistConfig(): void {
    if (this.log === undefined || this.config === undefined) return;
    void this.enqueueValues([
      setValue(
        SESSION_CONFIG,
        structuredClone(this.config.get()) as KernelConfig,
      ),
    ]);
  }

  /** Write the whole task ledger; ids are never reused, so a reload restores it. */
  private persistTasks(): void {
    if (this.log === undefined || this.tasks === undefined) return;
    void this.enqueueValues([
      setValue(TASKS_STATE, structuredClone(this.tasks.list()) as StoredTask[]),
    ]);
  }

  /** Commit bare value writes, ordered behind whatever the loop already queued. */
  private async enqueueValues(values: ValueWrite[]): Promise<void> {
    const log = this.log;
    if (log === undefined) return;
    this.noteWrites(values);
    const next = this.tail.then(() =>
      log.commit(values).catch(() => undefined),
    );
    this.tail = next;
    await next;
  }

  /**
   * Commit value writes, ordered behind whatever the loop already queued, and
   * wait for them. This is the door the state tools use: a key the model stores
   * has to be on disk before the turn that stored it ends.
   */
  async writeValues(values: ValueWrite[]): Promise<void> {
    // The one door value writes go through: tracking names here is what lets the
    // view's state section be a synchronous read.
    this.noteWrites(values);
    await this.enqueueValues(values);
    await this.tail;
  }

  /** A signature for "the entries changed" — not a count of anything a caller can use. */
  get version(): number {
    return this.entryVersion;
  }

  /** How many compactions stand between the history and now. */
  get compactionEpoch(): number {
    return this.compactionEpochValue;
  }

  /** The session totals the journal last committed (synchronous, for the view). */
  get usage(): Usage {
    return this.usageTotals;
  }

  /**
   * KV keys this session has written, plus whatever the caller loaded at open — every
   * namespace, or one of them when a `namespace` is named.
   */
  valueNames(namespace?: string): string[] {
    if (namespace !== undefined)
      return [...(this.valueKeys.get(namespace) ?? [])].sort();
    const all = new Set<string>();
    for (const keys of this.valueKeys.values())
      for (const key of keys) all.add(key);
    return [...all].sort();
  }

  /** Seed the key list at open, so a session that wrote keys in an earlier life shows them. */
  seedValueNames(keys: readonly string[], namespace?: string): void {
    for (const key of keys) this.keysIn(namespace ?? "").add(key);
  }

  private noteWrites(values: readonly ValueWrite[]): void {
    for (const write of values) {
      if (write.kind !== "value") continue;
      const keys = this.keysIn(write.namespace);
      if (write.op === "set") keys.add(write.key);
      else keys.delete(write.key);
    }
  }

  private keysIn(namespace: string): Set<string> {
    const existing = this.valueKeys.get(namespace);
    if (existing !== undefined) return existing;
    const created = new Set<string>();
    this.valueKeys.set(namespace, created);
    return created;
  }

  /**
   * Record the question before the tool waits (eta-agent's `onAsk`): a process
   * killed while a human thinks is a process whose question is still answerable
   * after a restart, because the entry is already there.
   */
  async recordAsk(payload: AskPayload): Promise<Entry | undefined> {
    return await this.recordPayload<AskEntry>(
      "ask",
      payload as unknown as Record<string, unknown>,
    );
  }

  /** Record a human's answer (or a dismissal), so a replay never re-surfaces it. */
  async recordAnswer(payload: AnswerPayload): Promise<Entry | undefined> {
    return await this.recordPayload<AnswerEntry>(
      "answer",
      payload as unknown as Record<string, unknown>,
    );
  }

  /**
   * Record a visible side note as a `btw` entry. The thread panel's history is the
   * journal's: a note that was saved is durable, and one that was not never
   * existed to anyone but the panel.
   */
  async recordNote(note: string): Promise<Entry | undefined> {
    const log = this.log;
    if (log === undefined) return undefined;
    const entry = log.record<BtwEntry>({
      id: btwId(),
      parentId: null,
      type: "btw",
      payload: { note },
    } as NewEntry<BtwEntry>);
    this.emit("entry:added", { entry });
    await this.enqueueCommit();
    return entry;
  }

  /** One entry of a kind whose payload is data rather than a message. */
  private async recordPayload<T extends Entry>(
    type: T["type"],
    payload: Record<string, unknown>,
  ): Promise<Entry | undefined> {
    const log = this.log;
    if (log === undefined) return undefined;
    this.entryVersion += 1;
    const entry = log.record<T>({
      id: payloadEntryId(),
      parentId: null,
      type,
      payload,
    } as unknown as NewEntry<T>);
    this.emit("entry:added", { entry });
    await this.enqueueCommit();
    return entry;
  }

  /** Every entry this session holds, oldest first. */
  entries(): readonly Entry[] {
    return this.log?.graph.pathOldestFirst() ?? [];
  }

  /** The transcript the journal replays into, oldest first. */
  transcript(): AgentMessage[] {
    return this.log?.transcript() ?? [];
  }

  /**
   * Record a usage measurement outside generation (eta-agent's
   * `lane.recordUsage`): a correction, or what a side request cost.
   */
  async recordUsage(
    usage: Usage,
    options: { entryId?: string; details?: JsonValue } = {},
  ): Promise<UsageRow | undefined> {
    const log = this.log;
    if (log === undefined) return undefined;
    log.recordUsage({
      id: usageId(),
      usage,
      adjustment: true,
      ...(options.entryId === undefined ? {} : { entryId: options.entryId }),
      ...(options.details === undefined ? {} : { details: options.details }),
    });
    const outcome = await this.enqueueCommit();
    const row = outcome?.usage[0];
    if (row !== undefined) {
      this.usageTotals = outcome!.result.stats.usage;
      this.emit("usage:recorded", { row, totals: outcome!.result.stats.usage });
    }
    return row;
  }

  /**
   * Make everything staged durable. The run boundary awaits this, so a
   * finished run is a durable run; everything else is fire-and-forget.
   */
  async flush(): Promise<void> {
    await this.enqueueCommit();
    await this.tail;
  }

  /** Record one message as an entry and announce it. */
  private record(
    message: AgentMessage,
    terminate = false,
  ): MessageEntry | undefined {
    const log = this.log;
    if (log === undefined) return undefined;
    this.entryVersion += 1;
    const entry = log.recordMessage(message);
    // A tool that ended the run says so on the entry; that marker is what a
    // replay uses to know the branch stopped there.
    if (terminate) entry.terminate = true;
    this.entryOf.set(message as object, entry);
    this.emit("entry:added", { entry });
    return entry;
  }

  /** The usage row for a turn's assistant message, riding in the same commit. */
  private recordUsageFor(message: AgentMessage, usage: Usage): void {
    const log = this.log;
    if (log === undefined) return;
    const entry = this.entryOf.get(message as object);
    if (entry === undefined) return;
    log.recordUsage({
      id: usageId(),
      usage,
      entryId: entry.id,
      adjustment: false,
    });
  }

  /**
   * The system record of a failed run. Not a message: the transcript never
   * projects it, so a retry does not send the failure back to the model.
   */
  private recordRunFailure(runId: string, error: string): void {
    const log = this.log;
    if (log === undefined || this.failedRuns.has(runId)) return;
    this.failedRuns.add(runId);
    this.entryVersion += 1;
    const entry = log.record<RunFailedEntry>({
      id: runFailedId(),
      parentId: null,
      type: "run_failed",
      payload: { runId, error },
    } as NewEntry<RunFailedEntry>);
    this.emit("entry:added", { entry });
  }

  /**
   * The system record of a stopped-and-regenerated generation. The discarded
   * output is not in it: only who stopped the attempt, why, and how much it had
   * produced. The reminder the interrupt injected is its own message entry.
   */
  private recordInterrupt(event: {
    runId: string;
    turnId: string;
    reason: string;
    source?: string;
    discardedChars: number;
  }): void {
    const log = this.log;
    if (log === undefined) return;
    this.entryVersion += 1;
    const entry = log.record<InterruptEntry>({
      id: interruptId(),
      parentId: null,
      type: "interrupt",
      payload: {
        runId: event.runId,
        turnId: event.turnId,
        reason: event.reason,
        ...(event.source === undefined ? {} : { source: event.source }),
        discardedChars: event.discardedChars,
      },
    } as NewEntry<InterruptEntry>);
    this.emit("entry:added", { entry });
  }

  /** The compaction entry a completed compaction produces. */
  private recordCompaction(event: {
    summary?: string;
    retainedTail?: readonly AgentMessage[];
    tokensBefore?: number;
    details?: JsonValue;
    usage?: Usage;
  }): void {
    const log = this.log;
    if (
      log === undefined ||
      event.summary === undefined ||
      event.tokensBefore === undefined
    )
      return;
    this.entryVersion += 1;
    this.compactionEpochValue += 1;
    const entry = log.record<Entry>({
      id: compactionId(),
      parentId: null,
      type: "compaction",
      summary: event.summary,
      retainedTail: [...(event.retainedTail ?? [])],
      tokensBefore: event.tokensBefore,
      ...(event.details === undefined ? {} : { details: event.details }),
      ...(event.usage === undefined ? {} : { usage: event.usage }),
    } as NewEntry<Entry>);
    this.emit("entry:added", { entry });
  }

  /**
   * Queue one commit; failures are reported, never thrown into the loop.
   * Whatever usage rows it carried are announced once they have landed, which
   * is what makes the totals a subscriber sees the totals on disk.
   */
  private enqueueCommit(): Promise<CommitOutcome | undefined> {
    const log = this.log;
    if (log === undefined) return Promise.resolve(undefined);
    const next = this.tail.then(async () => {
      try {
        const outcome = await log.commit();
        for (const row of outcome?.usage ?? []) {
          this.usageTotals = outcome!.result.stats.usage;
          this.emit("usage:recorded", {
            row,
            totals: outcome!.result.stats.usage,
          });
        }
        return outcome;
      } catch (error) {
        this.warn(
          `[eta-journal] commit failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }
    });
    this.tail = next;
    return next;
  }
  /**
   * Release the subscriptions. `ctx.on` is fiber-scoped, but a host may stop
   * journaling a session that stays alive (a manual takeover).
   */
  stop(): void {
    for (const off of this.offs.splice(0)) off();
  }
}
