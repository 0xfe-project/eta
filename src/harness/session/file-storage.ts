import { appendFile, mkdir, readFile, stat, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "../context.ts";
import { MemoryStorage } from "./memory.ts";
import type {
	CommitResult,
	Entry,
	EntryScan,
	EntryStructure,
	SessionStats,
	Storage,
	StorageBranchScan,
	UsageRow,
	UsageScan,
	Write,
} from "./types.ts";
import type { ListElement, ListReadOptions, StoredValue, Value, ValueList } from "./values.ts";

export interface FileStorageOptions {
	/** JSONL journal path; missing file means a fresh storage. */
	path: string;
	now?: () => number;
}

interface JournalLine {
	w: Write[];
	t: number;
}

/**
 * Log-structured persistence for the session storage protocol: every accepted
 * commit appends one JSON line, and load replays the journal into memory.
 * The journal is the whole truth — truncating to any line boundary is a valid
 * historical state (append-only, crash-safe by construction).
 *
 * Replay is total because of that: a journal holding one entry id twice — two
 * servers over one directory, or an interrupted tool result committed again when
 * its real output arrived — replays to the later write instead of refusing to
 * open the session. Truncation tolerance and duplicate tolerance are the same
 * property, seen from either end of the file.
 */
export class FileStorage implements Storage {
	private readonly path: string;
	private readonly memory: MemoryStorage;
	private appendQueue: Promise<void> = Promise.resolve();
	private state: "open" | "closing" | "closed" = "open";
	private closePromise: Promise<void> | undefined;
	/** Clock the caller asked for; only a replay overrides it, and only while replaying. */
	private readonly wallClock: () => number;
	private replaying = false;
	private replayAt = Date.now();
	/** Size this instance believes the journal has, so a second writer becomes visible. */
	private journalBytes = 0;
	private reportedForeignWriter = false;

	private constructor(options: FileStorageOptions) {
		this.path = options.path;
		this.wallClock = options.now ?? Date.now;
		this.memory = new MemoryStorage({
			now: () => (this.replaying ? this.replayAt : this.wallClock()),
		});
	}

	static async load(options: FileStorageOptions, context: Context): Promise<FileStorage> {
		let size = 0;
		try {
			size = (await stat(options.path)).size;
		} catch {
			size = 0;
		}
		let raw = "";
		try {
			raw = await readFile(options.path, "utf8");
		} catch {
			raw = "";
		}
		const storage = new FileStorage(options);
		storage.journalBytes = size;
		const ids = new Set<string>();
		const parents = new Map<string, string | null>();
		const lines = raw.split("\n");
		let repeated = 0;
		let brokenAt = -1;
		storage.replaying = true;
		try {
			for (let index = 0; index < lines.length; index += 1) {
				const trimmed = lines[index]!.trim();
				if (trimmed.length === 0) continue;
				let entry: JournalLine;
				try {
					entry = JSON.parse(trimmed) as JournalLine;
				} catch {
					// A process died mid-append. Any line boundary is a valid historical state,
					// so the journal ends here — the repair below cuts it off, or the same torn
					// tail would fail every later open and the session would freeze in place.
					brokenAt = index;
					break;
				}
				for (const write of entry.w) {
					if (write.kind === "entry") {
						parents.set(write.entry.id, write.entry.parentId);
						if (ids.has(write.entry.id)) repeated += 1;
						ids.add(write.entry.id);
					} else if (write.kind === "usage") {
						if (ids.has(write.row.id)) repeated += 1;
						ids.add(write.row.id);
					}
				}
				storage.replayAt = entry.t ?? storage.replayAt;
				await storage.memory.replay(entry.w, context);
			}
		} finally {
			storage.replaying = false;
		}
		if (brokenAt >= 0) await storage.repairTornTail(lines.slice(0, brokenAt), size);
		if (repeated > 0) {
			console.warn(
				`[eta-journal] ${storage.path}: ${repeated} repeated entry/usage id(s), kept the last write of each`,
			);
		}
		// Every parent is committed before its child, so an orphan here means the journal
		// stops before the parent it already refers to — a torn tail, not a lost branch.
		const orphans = [...parents].filter(([, parentId]) => parentId !== null && !ids.has(parentId!));
		if (orphans.length > 0) {
			storage.memory.allowBrokenBranches();
			console.warn(
				`[eta-journal] ${storage.path}: ${orphans.length} entr(ies) with a parent the journal never holds (first: ${orphans[0]![1]}), the branch ends there`,
			);
		}
		return storage;
	}

	/** Drop a torn tail so the next commit lands on a line boundary instead of after it. */
	private async repairTornTail(kept: readonly string[], readSize: number): Promise<void> {
		const encoder = new TextEncoder();
		const keepBytes = kept.reduce((total, line) => total + encoder.encode(line).length + 1, 0);
		const currentSize = await stat(this.path).then(
			(stats) => stats.size,
			() => -1,
		);
		if (currentSize !== readSize) {
			// Someone else is already writing past what we read; truncating would cut them off.
			console.warn(`[eta-journal] ${this.path}: unreadable tail and a concurrent writer, leaving it alone`);
			return;
		}
		await truncate(this.path, keepBytes);
		this.journalBytes = keepBytes;
		console.warn(
			`[eta-journal] ${this.path}: dropped ${readSize - keepBytes} unreadable trailing bytes, the journal resumes there`,
		);
	}

	async commit(writes: Write[], context: Context): Promise<CommitResult> {
		this.assertOpen();
		const result = await this.memory.commit(writes, context);
		await this.append({ w: writes, t: result.timestamp });
		return result;
	}

	private append(line: JournalLine): Promise<void> {
		const bytes = new TextEncoder().encode(JSON.stringify(line) + "\n");
		const next = this.appendQueue.then(async () => {
			await mkdir(dirname(this.path), { recursive: true });
			if (!this.reportedForeignWriter) {
				const before = await stat(this.path).then(
					(stats) => stats.size,
					() => this.journalBytes,
				);
				if (before > this.journalBytes) {
					this.reportedForeignWriter = true;
					console.warn(
						`[eta-journal] ${this.path}: ${before - this.journalBytes} bytes appended by another writer — two servers should not share one session directory`,
					);
				}
			}
			await appendFile(this.path, bytes);
			this.journalBytes += bytes.byteLength;
		});
		this.appendQueue = next.catch(() => undefined);
		return next;
	}

	async getEntries(ids: string[], context: Context): Promise<Map<string, Entry>> {
		this.assertOpen();
		return this.memory.getEntries(ids, context);
	}

	getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined> {
		return this.memory.getValue(address, context);
	}

	scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]> {
		return this.memory.scanValues(prefix, context);
	}

	readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		context: Context,
	): Promise<ListElement<T>[]> {
		return this.memory.readList(address, options, context);
	}

	async scanBranch(query: StorageBranchScan, context: Context): Promise<Entry[]> {
		this.assertOpen();
		return this.memory.scanBranch(query, context);
	}

	async scanBranchStructure(query: StorageBranchScan, context: Context): Promise<EntryStructure[]> {
		this.assertOpen();
		return this.memory.scanBranchStructure(query, context);
	}

	async scanEntries(query: EntryScan, context: Context): Promise<Entry[]> {
		this.assertOpen();
		return this.memory.scanEntries(query, context);
	}

	async scanUsage(query: UsageScan, context: Context): Promise<UsageRow[]> {
		this.assertOpen();
		return this.memory.scanUsage(query, context);
	}

	async getStats(context: Context): Promise<SessionStats> {
		this.assertOpen();
		return this.memory.getStats(context);
	}

	async close(context: Context): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		this.closePromise = (async () => {
			await this.appendQueue;
			await this.memory.close(context);
			this.state = "closed";
		})();
		return this.closePromise;
	}

	private assertOpen(): void {
		if (this.state !== "open") throw new Error("FileStorage is closed");
	}
}
