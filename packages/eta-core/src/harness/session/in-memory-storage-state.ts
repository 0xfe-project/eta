import { addUsage, emptyUsage, subtractUsage } from "../utils/usage.ts";
import { spliceMergedChain } from "./merge-splice.ts";
import {
	type CommittedListAppendWrite,
	type CommittedValueSetWrite,
	type CommittedWrite,
	type PreparedCommit,
	prepareStorageCommit,
	validateCommittedWrites,
} from "./commit.ts";
import { projectForkCurrentStateWrite, selectBranchFork } from "./fork-policy.ts";

export type {
	CommittedEntryWrite,
	CommittedListAppendWrite,
	CommittedListDeleteWrite,
	CommittedUsageWrite,
	CommittedValueDeleteWrite,
	CommittedValueSetWrite,
	CommittedWrite,
	PreparedCommit,
} from "./commit.ts";

import type {
	Entry,
	EntryScan,
	EntryStructure,
	ForkOptions,
	NewEntry,
	SessionStats,
	StorageBranchScan,
	UsageRow,
	UsageScan,
	Write,
} from "./types.ts";
import {
	branchTip,
	type ListElement,
	type ListReadOptions,
	laneConfig,
	laneState,
	list,
	resolveListReadOptions,
	type StoredValue,
	type Value,
	type ValueList,
	value,
} from "./values.ts";

/** One line of a journal rebuilt from live state; `FileStorage` gives it its wire shape. */
export interface StateJournalLine {
	writes: Write[];
	timestamp: number;
}

/** Live writes per rebuilt line: a session can hold millions of them in one list. */
const REWRITE_LINE_WRITES = 512;

interface StoredListSnapshot {
	address: ValueList<unknown>;
	elements: ListElement<unknown>[];
}

type MemoryForkPlan =
	| { scope: "tree" }
	| { scope: "branch"; branch: string; destinationTip: string | null; entryIds: Set<string> };

function physicalKey(namespace: string, key: string): string {
	return `${namespace}\u0000${key}`;
}

function compareKeys(left: string, right: string): number {
	const leftCodePoints = Array.from(left, (character) => character.codePointAt(0)!);
	const rightCodePoints = Array.from(right, (character) => character.codePointAt(0)!);
	const length = Math.min(leftCodePoints.length, rightCodePoints.length);
	for (let index = 0; index < length; index++) {
		const difference = leftCodePoints[index]! - rightCodePoints[index]!;
		if (difference !== 0) return difference;
	}
	return leftCodePoints.length - rightCodePoints.length;
}

/**
 * Complete materialized session state for MemoryStorage.
 *
 * This is intentionally unsuitable for database backends and long-running sessions that may not fit in memory.
 * Those backends should query indexed durable state and update durable aggregates within each commit transaction.
 */
export class InMemoryStorageState {
	private readonly entries: Map<string, Entry>;
	private readonly entriesBySeq: Entry[];
	private readonly scalarValues: Map<string, StoredValue<unknown>>;
	private readonly listValues: Map<string, StoredListSnapshot>;
	private readonly usage: Map<string, UsageRow>;
	private stats: SessionStats;
	private nextSeq: number;
	/**
	 * Set when the state was rebuilt from a journal. A journal can name a parent it never
	 * holds — the commit that would have carried it was rejected as a duplicate by a second
	 * writer — and losing the whole chat over one hole is worse than showing the branch up
	 * to it. Live writes still get the strict check.
	 */
	private brokenBranchesAllowed = false;
	private reportedBrokenBranch = false;

	constructor() {
		this.entries = new Map();
		this.entriesBySeq = [];
		this.scalarValues = new Map();
		this.listValues = new Map();
		this.usage = new Map();
		this.stats = { messageCount: 0, usage: emptyUsage() };
		this.nextSeq = 1;
	}

	prepareCommit(writes: Write[], timestamp: number): PreparedCommit {
		const prepared = prepareStorageCommit(writes, this.nextSeq, timestamp);
		this.validateCommitted(prepared.writes);
		return prepared;
	}

	/** Same sequencing as `prepareCommit`, without the duplicate-id rejection. */
	prepareReplay(writes: Write[], timestamp: number): PreparedCommit {
		return prepareStorageCommit(writes, this.nextSeq, timestamp);
	}

	/**
	 * The journal this state would need to be rebuilt from nothing: one line per moment an
	 * entry was accepted, holding what was accepted then, and one tail of every value and
	 * list element still alive. Deletes and superseded values are absent by construction —
	 * a rebuild that carried them would be a copy of the file rather than a repair of it.
	 *
	 * Entries are emitted in sequence order, so a replay that assigns fresh sequence numbers
	 * still walks parents before children. They are grouped by the timestamp they hold,
	 * because a replay stamps an entry with its line's timestamp: a rewrite that flattened
	 * those would date the whole chat to the moment it ran.
	 */
	journalFromState(): StateJournalLine[] {
		const lines = new Map<number, Write[]>();
		const lineAt = (timestamp: number): Write[] => {
			let writes = lines.get(timestamp);
			if (writes === undefined) {
				writes = [];
				lines.set(timestamp, writes);
			}
			return writes;
		};
		let newest = 0;
		for (const entry of this.entriesBySeq) {
			const { seq: _seq, timestamp, ...rest } = entry;
			lineAt(timestamp).push({ kind: "entry", entry: rest as NewEntry });
			newest = Math.max(newest, timestamp);
		}
		for (const row of this.usage.values()) {
			// A usage row belongs with the message it was spent on; an adjustment or an orphan
			// rides the newest line rather than inventing a moment of its own.
			const owner = row.entryId === undefined ? undefined : this.entries.get(row.entryId);
			const { seq: _seq, ...withoutSeq } = row;
			lineAt(owner?.timestamp ?? newest).push({ kind: "usage", row: withoutSeq });
		}
		const alive: Write[] = [
			...[...this.scalarValues.values()].map((stored) => ({
				kind: "value" as const,
				op: "set" as const,
				namespace: stored.address.namespace,
				key: stored.address.key,
				value: stored.value,
			})),
			...[...this.listValues.values()].flatMap((snapshot) =>
				snapshot.elements.map((element) => ({
					kind: "list" as const,
					op: "append" as const,
					namespace: snapshot.address.namespace,
					key: snapshot.address.key,
					value: element.value,
				})),
			),
		];
		// A session can hold a million live list elements; one line per commit stays small.
		for (let start = 0; start < alive.length; start += REWRITE_LINE_WRITES) {
			lineAt(newest).push(...alive.slice(start, start + REWRITE_LINE_WRITES));
		}
		return [...lines].map(([timestamp, writes]) => ({ writes, timestamp }));
	}

	/** Let a branch walk end at an entry whose parent the journal never held. */
	allowBrokenBranches(): void {
		this.brokenBranchesAllowed = true;
	}

	/**
	 * Apply a commit the journal already accepted. A repeated entry/usage id overwrites
	 * in place instead of throwing: the journal is append-only, so the later write is the
	 * newer truth — a tool result first committed as an interruption placeholder and again
	 * when the real output arrived. Refusing to replay would make the session unopenable
	 * forever over one repeated id.
	 */
	applyReplay(writes: readonly CommittedWrite[]): SessionStats {
		for (const write of writes) {
			switch (write.kind) {
				case "entry": {
					const { kind: _kind, ...entry } = write;
					const previous = this.entries.get(entry.id);
					this.entries.set(entry.id, entry);
					if (previous === undefined) {
						this.entriesBySeq.push(entry);
					} else {
						const index = this.entriesBySeq.findIndex((candidate) => candidate.id === entry.id);
						if (index >= 0) this.entriesBySeq[index] = entry;
					}
					if ((previous?.type === "message") !== (entry.type === "message")) {
						this.stats = {
							...this.stats,
							messageCount: this.stats.messageCount + (entry.type === "message" ? 1 : -1),
						};
					}
					break;
				}
				case "usage": {
					const { kind: _kind, ...row } = write;
					const previous = this.usage.get(row.id);
					if (previous !== undefined) {
						this.stats = { ...this.stats, usage: subtractUsage(this.stats.usage, previous.usage) };
					}
					this.usage.set(row.id, row);
					this.stats = { ...this.stats, usage: addUsage(this.stats.usage, row.usage) };
					break;
				}
				default:
					// Values and list elements are already last-write-wins by sequence.
					this.applyValidated([write]);
					continue;
				}
				this.nextSeq = write.seq + 1;
			}
		return this.stats;
	}

	validateCommitted(writes: readonly CommittedWrite[]): void {
		validateCommittedWrites(writes, this.nextSeq, {
			hasEntryOrUsageId: (id) => this.entries.has(id) || this.usage.has(id),
			hasEntryId: (id) => this.entries.has(id),
		});
	}

	/** Apply writes already accepted by validateCommitted() and return the post-apply totals. */
	applyValidated(writes: readonly CommittedWrite[]): SessionStats {
		for (const write of writes) {
			switch (write.kind) {
				case "entry": {
					const { kind: _kind, ...entry } = write;
					this.entries.set(entry.id, entry);
					this.entriesBySeq.push(entry);
					if (entry.type === "message") this.stats = { ...this.stats, messageCount: this.stats.messageCount + 1 };
					break;
				}
				case "usage": {
					const { kind: _kind, ...row } = write;
					this.usage.set(row.id, row);
					this.stats = { ...this.stats, usage: addUsage(this.stats.usage, row.usage) };
					break;
				}
				case "value":
					if (write.op === "delete") this.scalarValues.delete(physicalKey(write.namespace, write.key));
					else this.applyValueSetOrListAppend(write);
					break;
				case "list":
					if (write.op === "delete") this.listValues.delete(physicalKey(write.namespace, write.key));
					else this.applyValueSetOrListAppend(write);
					break;
			}
			this.nextSeq = write.seq + 1;
		}
		return this.stats;
	}

	createFork(options: ForkOptions): InMemoryStorageState {
		const plan = this.selectForkPlan(options);

		const isEntryCopied = (entryId: string): boolean => {
			if (plan.scope === "tree") return true;
			return plan.entryIds.has(entryId);
		};
		const destination = new InMemoryStorageState();
		let messageCount = 0;
		for (const entry of this.entriesBySeq) {
			if (!isEntryCopied(entry.id)) continue;
			destination.entries.set(entry.id, entry);
			destination.entriesBySeq.push(entry);
			if (entry.type === "message") messageCount++;
		}
		destination.stats = { ...destination.stats, messageCount };

		for (const stored of this.scalarValues.values()) {
			const projected = projectForkCurrentStateWrite(
				{
					kind: "value",
					op: "set",
					seq: stored.seq,
					namespace: stored.address.namespace,
					key: stored.address.key,
					value: stored.value,
				},
				plan,
				isEntryCopied,
			);
			if (projected !== undefined) destination.applyValueSetOrListAppend(projected);
		}

		for (const stored of this.listValues.values()) {
			for (const element of stored.elements) {
				const projected = projectForkCurrentStateWrite(
					{
						kind: "list",
						op: "append",
						seq: element.seq,
						namespace: stored.address.namespace,
						key: stored.address.key,
						value: element.value,
					},
					plan,
					isEntryCopied,
				);
				if (projected !== undefined) destination.applyValueSetOrListAppend(projected);
			}
		}
		destination.nextSeq = this.nextSeq;
		return destination;
	}

	private selectForkPlan(options: ForkOptions): MemoryForkPlan {
		if (options.scope === "tree") return { scope: "tree" };

		const entryIds = new Set<string>();
		const plan = selectBranchFork(options, {
			tip: this.getValue(branchTip(options.branch))?.value,
			getParent: (entryId) => this.entries.get(entryId)?.parentId,
			selectEntry: (entryId) => entryIds.add(entryId),
		});
		if (
			this.getValue(laneConfig(options.branch)) === undefined ||
			this.getValue(laneState(options.branch)) === undefined
		) {
			throw new Error(`Source branch ${JSON.stringify(options.branch)} is not a configured AgentLane`);
		}
		return { ...plan, entryIds };
	}

	private applyValueSetOrListAppend(write: CommittedValueSetWrite | CommittedListAppendWrite): void {
		const key = physicalKey(write.namespace, write.key);
		if (write.kind === "value") {
			this.scalarValues.set(key, {
				address: value<unknown>(write.namespace, write.key),
				value: write.value,
				seq: write.seq,
			});
			return;
		}

		const element = { seq: write.seq, value: write.value };
		const stored = this.listValues.get(key);
		if (stored === undefined) {
			this.listValues.set(key, {
				address: list<unknown>(write.namespace, write.key),
				elements: [element],
			});
		} else {
			stored.elements.push(element);
		}
	}

	advanceNextSeq(nextSeq: number): void {
		if (!Number.isSafeInteger(nextSeq) || nextSeq < 1) {
			throw new Error(`Invalid storage sequence high-water mark: ${nextSeq}`);
		}
		this.nextSeq = Math.max(this.nextSeq, nextSeq);
	}

	getEntries(ids: readonly string[]): Map<string, Entry> {
		const found = new Map<string, Entry>();
		for (const id of ids) {
			const entry = this.entries.get(id);
			if (entry !== undefined) found.set(id, entry);
		}
		return found;
	}

	getValue<T>(address: Value<T>): StoredValue<T> | undefined {
		return this.scalarValues.get(physicalKey(address.namespace, address.key)) as StoredValue<T> | undefined;
	}

	scanValues<T>(prefix: Value<T>): StoredValue<T>[] {
		return [...this.scalarValues.values()]
			.filter((stored) => stored.address.namespace === prefix.namespace && stored.address.key.startsWith(prefix.key))
			.sort((left, right) => compareKeys(left.address.key, right.address.key)) as StoredValue<T>[];
	}

	readList<T>(address: ValueList<T>, options?: ListReadOptions): ListElement<T>[] {
		const resolved = resolveListReadOptions(options);
		const elements = this.listValues.get(physicalKey(address.namespace, address.key))?.elements ?? [];
		const filtered = elements.filter((element) => {
			if (resolved.cursor === undefined) return true;
			return resolved.order === "asc" ? element.seq > resolved.cursor.seq : element.seq < resolved.cursor.seq;
		});
		const ordered = resolved.order === "asc" ? filtered : [...filtered].reverse();
		return ordered.slice(0, resolved.limit) as ListElement<T>[];
	}

	scanBranch(query: StorageBranchScan): Entry[] {
		const start = this.entries.get(query.start);
		if (start === undefined) throw new Error(`Unknown branch start: ${query.start}`);

		const path: Entry[] = [];
		let entry: Entry | undefined = start;
		while (entry !== undefined) {
			path.push(entry);
			if (entry.parentId === null) break;
			entry = this.entries.get(entry.parentId);
			if (entry === undefined) {
				if (!this.brokenBranchesAllowed) throw new Error("Corrupt branch: missing parent");
				if (!this.reportedBrokenBranch) {
					this.reportedBrokenBranch = true;
					console.warn(
						`[eta-journal] branch walk stopped at ${path[0]?.id ?? "?"}: parent ${path.at(-1)!.parentId} is not in the journal`,
					);
				}
				break;
			}
		}
		spliceMergedChain(path, (id) => this.entries.get(id));
		if (query.order === "oldestFirst") path.reverse();

		const stopped: Entry[] = [];
		for (const candidate of path) {
			stopped.push(candidate);
			if (candidate.id === query.stopAtId || candidate.type === query.stopAtType) break;
		}
		const filtered = stopped
			.filter((candidate) => query.type === undefined || candidate.type === query.type)
			.filter((candidate) => query.customType === undefined || candidate.customType === query.customType)
			.filter(
				(candidate) =>
					query.cursor === undefined ||
					(query.order === "oldestFirst" ? candidate.seq > query.cursor.seq : candidate.seq < query.cursor.seq),
			);
		return query.limit === undefined ? filtered : filtered.slice(0, Math.max(0, query.limit));
	}

	scanBranchStructure(query: StorageBranchScan): EntryStructure[] {
		return this.scanBranch(query).map((entry) => ({
			id: entry.id,
			parentId: entry.parentId,
			...(entry.type === "merge" ? { mergedParentId: entry.mergedParentId } : {}),
			seq: entry.seq,
			timestamp: entry.timestamp,
			type: entry.type,
			...(entry.customType === undefined ? {} : { customType: entry.customType }),
		}));
	}

	scanEntries(query: EntryScan): Entry[] {
		const limit = query.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.trunc(query.limit));
		const entries: Entry[] = [];
		const descending = query.order === "desc";
		let index = descending ? this.entriesBySeq.length - 1 : 0;
		while (index >= 0 && index < this.entriesBySeq.length && entries.length < limit) {
			const entry = this.entriesBySeq[index]!;
			if (
				(query.type === undefined || entry.type === query.type) &&
				(query.customType === undefined || entry.customType === query.customType) &&
				(query.fromSeq === undefined || entry.seq >= query.fromSeq) &&
				(query.toSeq === undefined || entry.seq <= query.toSeq)
			) {
				entries.push(entry);
			}
			index += descending ? -1 : 1;
		}
		return entries;
	}

	scanUsage(query: UsageScan): UsageRow[] {
		const rows = [...this.usage.values()]
			.filter((row) => query.fromSeq === undefined || row.seq >= query.fromSeq)
			.filter((row) => query.toSeq === undefined || row.seq <= query.toSeq)
			.sort((left, right) => (query.order === "desc" ? right.seq - left.seq : left.seq - right.seq));
		return query.limit === undefined ? rows : rows.slice(0, Math.max(0, query.limit));
	}

	getStats(): SessionStats {
		return this.stats;
	}

	getNextSeq(): number {
		return this.nextSeq;
	}
}
