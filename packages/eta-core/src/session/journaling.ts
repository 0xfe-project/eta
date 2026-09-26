/**
 * JournalingService — durability as a subscriber (REFACTOR.md §3 ruling 6,
 * §K5).
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
 * - `turn:run-end`     → whatever is still staged.
 *
 * The entry ids live here now, which is why `message:end` carries no entryId:
 * an id exists once it has been written, and `entry:added` is where a consumer
 * learns it.
 */
import { type Context, Service } from "cordis";
import type { ConfigService } from "../kernel/config";
import type { TaskService } from "../kernel/tasks";
import { setValue, type UsageRow, type ValueWrite, value } from "../storage/types";
import type { KernelConfig } from "../types/config";
import type { Entry, MessageEntry, NewEntry } from "../types/entries";
import type { Emit } from "../types/events";
import { kernelEmit, kernelOn } from "../types/events";
import type { JsonValue } from "../types/json";
import type { AgentMessage, Usage } from "../types/messages";
import type { StoredTask } from "../types/tasks";
import type { CommitOutcome, SessionLog } from "./session-log";

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
function usageId(): string {
	usageCounter += 1;
	return `usage-${usageCounter.toString(36)}-${Date.now().toString(36)}`;
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
		void this.enqueueValues([setValue(SESSION_CONFIG, structuredClone(this.config.get()) as KernelConfig)]);
	}

	/** Write the whole task ledger; ids are never reused, so a reload restores it. */
	private persistTasks(): void {
		if (this.log === undefined || this.tasks === undefined) return;
		void this.enqueueValues([setValue(TASKS_STATE, structuredClone(this.tasks.list()) as StoredTask[])]);
	}

	/** Commit bare value writes, ordered behind whatever the loop already queued. */
	private async enqueueValues(values: ValueWrite[]): Promise<void> {
		const log = this.log;
		if (log === undefined) return;
		const next = this.tail.then(() => log.commit(values).catch(() => undefined));
		this.tail = next;
		await next;
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
		if (row !== undefined) this.emit("usage:recorded", { row, totals: outcome!.result.stats.usage });
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
	private record(message: AgentMessage, terminate = false): MessageEntry | undefined {
		const log = this.log;
		if (log === undefined) return undefined;
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
		log.recordUsage({ id: usageId(), usage, entryId: entry.id, adjustment: false });
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
		if (log === undefined || event.summary === undefined || event.tokensBefore === undefined) return;
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
					this.emit("usage:recorded", { row, totals: outcome!.result.stats.usage });
				}
				return outcome;
			} catch (error) {
				this.warn(`[eta-journal] commit failed: ${error instanceof Error ? error.message : String(error)}`);
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
