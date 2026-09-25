/**
 * SessionLog — the journal a crash can be measured against (REFACTOR.md §K5).
 *
 * The run is the unit of work. A run writes a start marker, commits each turn
 * as it completes, and closes with a boundary commit. The boundary is the
 * stable point: everything up to it is state the system agreed to, everything
 * past it belongs to a run that never finished and is dropped on replay.
 *
 * Per-turn commits are not a resume mechanism — they let a live journal be
 * read while a run is in flight (a dashboard, a second window). Recovery does
 * not resume a half-finished run; the host drives it again. That is what
 * deleted the durable-operation state machine: one rule instead of a ledger.
 *
 * Key/value state rides on the boundary commit, so an aborted run cannot leave
 * a half-written value behind.
 */
import type { StorageService } from "../storage/types.ts";
import type { Entry, GoalEntry, MessageEntry, NewEntry } from "../types/entries.ts";
import type { kernelOn } from "../types/events.ts";
import type { AgentMessage } from "../types/messages.ts";
import { EntryGraph } from "./graph.ts";

/** Commit value marking a run in flight. */
export const RUN_STARTED = "run.started";
/** Commit value marking a clean run boundary — the stable recovery point. */
export const RUN_BOUNDARY = "run.boundary";
/** The entry the last clean run ended on, recorded with the boundary. */
export const RUN_TERMINATE = "run.terminateEntryId";

/** The journal's own markers: journal metadata, not session state to rewind. */
const RESERVED_VALUE_KEYS = new Set([RUN_STARTED, RUN_BOUNDARY, RUN_TERMINATE]);

export interface RecoveryReport {
	/** Commits after the last stable boundary, discarded. */
	droppedCommits: number;
	/** Entries inside those commits. */
	droppedEntries: number;
	/** A run was in flight when the process died. */
	hadRunInFlight: boolean;
	/** Clean boundaries found in the journal. */
	boundaries: number;
	/** Keys whose values were written by the aborted run and rolled back. */
	rolledBackValues: string[];
}

const NO_RECOVERY: RecoveryReport = {
	droppedCommits: 0,
	droppedEntries: 0,
	hadRunInFlight: false,
	boundaries: 0,
	rolledBackValues: [],
};

export class SessionLog {
	readonly storage: StorageService;
	readonly graph: EntryGraph;

	private staged: Entry[] = [];
	private runOpen = false;
	private recovery: RecoveryReport = NO_RECOVERY;

	private constructor(storage: StorageService, graph: EntryGraph) {
		this.storage = storage;
		this.graph = graph;
	}

	/** A journal that starts empty. */
	static create(storage: StorageService): SessionLog {
		return new SessionLog(storage, new EntryGraph());
	}

	/**
	 * Replay a journal for recovery: whatever an aborted run left past the last
	 * boundary is dropped, because that work never reached a stable point.
	 */
	static async load(storage: StorageService): Promise<SessionLog> {
		return SessionLog.replay(storage, true);
	}

	/**
	 * Replay a journal as a live projection: nothing is trimmed, so a reader can
	 * watch a run in progress. Per-turn commits are what make this possible;
	 * recovery still starts from the last boundary, not from here.
	 */
	static async view(storage: StorageService): Promise<SessionLog> {
		return SessionLog.replay(storage, false);
	}

	private static async replay(storage: StorageService, recover: boolean): Promise<SessionLog> {
		const log = new SessionLog(storage, new EntryGraph());
		const commits = await storage.readJournal();

		let openRunAt = -1;
		let boundaries = 0;
		commits.forEach((commit, index) => {
			const values = commit.values as Record<string, unknown> | undefined;
			if (openRunAt === -1 && values?.[RUN_STARTED] === true) openRunAt = index;
			if (values?.[RUN_BOUNDARY] === true) {
				openRunAt = -1;
				boundaries += 1;
			}
		});

		const hadRunInFlight = openRunAt !== -1;
		const cutAt = recover ? openRunAt : -1;
		const kept = cutAt === -1 ? commits : commits.slice(0, cutAt);
		const dropped = cutAt === -1 ? [] : commits.slice(cutAt);
		for (const commit of kept) {
			for (const entry of commit.entries) log.graph.append(entry);
		}

		// Values the aborted run wrote never became state: rewind them to what the
		// last committed run left, key by key.
		const rolledBackValues: string[] = [];
		if (recover && dropped.length > 0) {
			const settled = new Map<string, { value: unknown }>();
			for (const commit of kept) {
				for (const [key, value] of Object.entries(commit.values ?? {})) settled.set(key, { value });
				for (const key of commit.deletes ?? []) settled.delete(key);
			}
			for (const commit of dropped) {
				for (const key of Object.keys(commit.values ?? {})) rolledBackValues.push(key);
				for (const key of commit.deletes ?? []) rolledBackValues.push(key);
			}
			for (const key of RESERVED_VALUE_KEYS) {
				const at = rolledBackValues.indexOf(key);
				if (at !== -1) rolledBackValues.splice(at, 1);
			}
			for (const key of new Set(rolledBackValues)) {
				const settledValue = settled.get(key);
				if (settledValue === undefined) await storage.remove(key);
				else await storage.set(key, settledValue.value);
			}
		}

		log.recovery = {
			droppedCommits: dropped.length,
			droppedEntries: dropped.reduce((total, commit) => total + commit.entries.length, 0),
			hadRunInFlight,
			boundaries,
			rolledBackValues: [...new Set(rolledBackValues)],
		};
		return log;
	}

	/** What the last load had to discard, if anything. */
	get recovered(): RecoveryReport {
		return this.recovery;
	}

	/** Entries staged but not yet committed (the turn in flight). */
	get pending(): readonly Entry[] {
		return this.staged;
	}

	/** A run is starting. Everything after this point is provisional until a boundary. */
	async beginRun(): Promise<void> {
		if (this.runOpen) return;
		this.runOpen = true;
		await this.storage.append({ entries: [], values: { [RUN_STARTED]: true } });
	}

	/** Record an entry in the graph and the pending commit. */
	stage<T extends Entry>(entry: NewEntry<T>): T {
		const full = this.graph.append(entry);
		this.staged.push(full);
		return full;
	}

	/** Record a transcript message. */
	stageMessage(message: AgentMessage): MessageEntry {
		return this.stage<MessageEntry>({
			id: messageId(),
			parentId: null,
			type: "message",
			message,
		} as NewEntry<MessageEntry>);
	}

	/** Make the pending entries durable, keeping the run open. */
	async commitTurn(): Promise<void> {
		if (this.staged.length === 0) return;
		const entries = this.staged;
		this.staged = [];
		await this.storage.append({ entries });
	}

	/**
	 * Close the run: the last entry is marked as the stable boundary, the
	 * pending entries are written, and the boundary marker lands with them.
	 */
	async endRun(values?: Record<string, unknown>): Promise<void> {
		const entries = this.staged;
		this.staged = [];
		this.runOpen = false;
		await this.storage.append({
			entries,
			values: {
				[RUN_STARTED]: false,
				[RUN_BOUNDARY]: true,
				[RUN_TERMINATE]: this.graph.tipId(),
				...(values ?? {}),
			},
		});
	}

	/**
	 * The transcript this journal replayed into the branch view, oldest first —
	 * what a runner resumes with after a restart. Entries a merge or fork left
	 * off the path are included, since the path is the branch's own history.
	 */
	transcript(): AgentMessage[] {
		return this.graph
			.pathOldestFirst()
			.filter((entry): entry is MessageEntry => entry.type === "message")
			.map((entry) => entry.message);
	}
}

/**
 * Mirror goal changes into the journal as `goal` entries. State changes become
 * history through subscribers, not by the primitive reaching for storage
 * (REFACTOR.md §2.3): the goal service emits, this writes, replay restores.
 */
export function recordGoalEntries(log: SessionLog, subscribe: ReturnType<typeof kernelOn>): { stop: () => void } {
	const off: (() => boolean)[] = [];
	off.push(
		subscribe("goal:changed", (event) => {
			log.stage<GoalEntry>({
				id: messageId(),
				parentId: null,
				type: "goal",
				payload: {
					kind: event.kind,
					...(event.objective === undefined ? {} : { objective: event.objective }),
					...(event.reason === undefined ? {} : { reason: event.reason }),
				},
			} as NewEntry<GoalEntry>);
		}),
	);
	off.push(
		subscribe("goal:cleared", (event) => {
			log.stage<GoalEntry>({
				id: messageId(),
				parentId: null,
				type: "goal",
				payload: { kind: "cleared", ...(event.objective === undefined ? {} : { objective: event.objective }) },
			} as NewEntry<GoalEntry>);
		}),
	);
	return { stop: () => off.forEach((unsubscribe) => void unsubscribe()) };
}

let messageCounter = 0;

function messageId(): string {
	messageCounter += 1;
	return `msg-${messageCounter.toString(36)}-${Date.now().toString(36)}`;
}
