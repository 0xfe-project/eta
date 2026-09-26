/**
 * SessionLog — journaling for the entry graph (REFACTOR.md §K5).
 *
 * The journal is append-only and the recovery rule is one line: everything a
 * commit landed is state; a crash mid-write leaves a torn tail the storage
 * layer cuts. There are no run markers and nothing is dropped at replay —
 * committed turns survive a restart intact, and the host re-drives whatever
 * was in flight (a goal continuation, a user prompt), because a turn is
 * idempotent and replaying it is cheap.
 *
 * Writes stage in memory and land as one atomic commit per turn, so the file
 * never holds half an entry. `load` replays the full journal into the graph.
 */
import type { CommitResult, StorageService, UsageRow, ValueWrite } from "../storage/types.ts";
import type { Entry, MessageEntry, NewEntry } from "../types/entries.ts";
import type { AgentMessage } from "../types/messages.ts";
import { EntryGraph } from "./graph.ts";

export interface CommitOutcome {
	result: CommitResult;
	/** The entries as committed, with the sequence each landed on. */
	entries: Entry[];
	/** The usage rows as committed, with their sequence. */
	usage: UsageRow[];
}

export class SessionLog {
	readonly storage: StorageService;
	readonly graph: EntryGraph;

	private staged: Entry[] = [];
	private stagedUsage: Omit<UsageRow, "seq">[] = [];

	private constructor(storage: StorageService, graph: EntryGraph) {
		this.storage = storage;
		this.graph = graph;
	}

	/** A journal that starts empty. */
	static create(storage: StorageService): SessionLog {
		return new SessionLog(storage, new EntryGraph());
	}

	/**
	 * Replay the journal. Everything committed is kept — the storage layer has
	 * already cut torn bytes, so what arrives here is complete entries only.
	 */
	static async load(storage: StorageService): Promise<SessionLog> {
		const log = new SessionLog(storage, new EntryGraph());
		const entries = await storage.scanEntries({ order: "asc" });
		const known = new Set(entries.map((entry) => entry.id));
		for (const entry of entries) {
			// An entry whose parent is not in the journal ends the branch there
			// instead of failing the open (eta-agent's allowBrokenBranches).
			if (entry.parentId !== null && !known.has(entry.parentId)) log.orphans += 1;
			log.graph.append(entry, { allowMissingParent: true });
		}
		return log;
	}

	/** Entries whose parent the journal does not hold; their branch ends there. */
	orphans = 0;

	/** Entries staged but not yet committed (the turn in flight). */
	get pending(): readonly Entry[] {
		return this.staged;
	}

	/** Record an entry in the graph and the pending commit. */
	record<T extends Entry>(entry: NewEntry<T>): T {
		const full = this.graph.append(entry);
		this.staged.push(full);
		return full;
	}

	/** Record a transcript message. */
	recordMessage(message: AgentMessage): MessageEntry {
		return this.record<MessageEntry>({
			id: messageId(),
			parentId: null,
			type: "message",
			message,
		} as NewEntry<MessageEntry>);
	}

	/** Record a usage measurement for the assistant entry it was spent on. */
	recordUsage(row: Omit<UsageRow, "seq">): void {
		this.stagedUsage.push(row);
	}

	/** Usage rows staged but not yet committed. */
	get pendingUsage(): readonly Omit<UsageRow, "seq">[] {
		return this.stagedUsage;
	}

	/**
	 * Make everything staged durable, atomically. Call once per turn: the
	 * journal then holds complete turns and nothing else.
	 */
	async commit(values: ValueWrite[] = []): Promise<CommitOutcome | undefined> {
		if (this.staged.length === 0 && this.stagedUsage.length === 0 && values.length === 0) return undefined;
		const entries = this.staged;
		const usage = this.stagedUsage;
		this.staged = [];
		this.stagedUsage = [];
		const result = await this.storage.commit([
			...entries.map((entry) => ({ kind: "entry" as const, entry })),
			...usage.map((row) => ({ kind: "usage" as const, row })),
			...values,
		]);
		// Seqs arrive in write order, so the committed rows can be handed back with
		// the sequence they actually landed on.
		return {
			result,
			entries: entries.map((entry, index) => ({ ...entry, seq: result.seqs[index]! }) as Entry),
			usage: usage.map((row, index) => ({ ...row, seq: result.seqs[entries.length + index]! })),
		};
	}

	/**
	 * The transcript this journal holds on the branch view, oldest first.
	 *
	 * A compaction entry stands in for the history it replaced: walking oldest
	 * first, the accumulated messages are reset to [summary, ...retainedTail]
	 * at that point. The messages before the cut stay in the journal — they are
	 * history — but they are no longer what the model is sent.
	 */
	transcript(projectors?: Record<string, (entry: Entry) => AgentMessage | undefined>): AgentMessage[] {
		let messages: AgentMessage[] = [];
		for (const entry of this.graph.pathOldestFirst()) {
			if (entry.type === "message") {
				messages.push((entry as MessageEntry).message);
				continue;
			}
			if (entry.type === "compaction") {
				messages = [
					{
						role: "compactionSummary",
						summary: entry.summary,
						tokensBefore: entry.tokensBefore,
						timestamp: entry.timestamp,
					},
					...entry.retainedTail,
				];
				continue;
			}
			if (entry.type === "branch_summary") {
				messages = [
					{
						role: "branchSummary",
						summary: entry.summary,
						fromId: entry.fromId,
						timestamp: entry.timestamp,
					},
				];
				continue;
			}
			// A plugin's own entry kind: it taught the transcript about it through a
			// projector, so the history reads the way that plugin defined it.
			const projector = projectors?.[entry.type];
			if (projector !== undefined) {
				const projected = projector(entry);
				if (projected !== undefined) messages.push(projected);
			}
		}
		return messages;
	}
}

let messageCounter = 0;

function messageId(): string {
	messageCounter += 1;
	return `msg-${messageCounter.toString(36)}-${Date.now().toString(36)}`;
}
