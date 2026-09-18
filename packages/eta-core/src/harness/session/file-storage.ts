import { appendFile, mkdir, open, readFile, rename, stat } from "node:fs/promises";
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
	/**
	 * Rebuild the journal after a reopen when it has grown far past what the live state
	 * needs. Default true: a session that ran for days holds millions of streaming frames
	 * that say nothing once the message they built is committed, and paying to replay them
	 * on every open is how a session reaches the point where it does not open at all.
	 */
	compactOnLoad?: boolean;
	/** Journal size below which no rebuild is attempted. */
	compactMinBytes?: number;
	/** Growth since the last rebuild that triggers another one; 0 never triggers. */
	compactGrowthBytes?: number;
	/** How long a session must be quiet before a growth-triggered rebuild runs. */
	compactQuietMs?: number;
}

interface JournalLine {
	w: Write[];
	t: number;
}

export interface FileStorageCompaction {
	/** Journal size before the attempt. */
	beforeBytes: number;
	/** Journal size after it; equals `beforeBytes` when nothing was rewritten. */
	afterBytes: number;
	rewritten: boolean;
	reason?: "concurrent-writer" | "not-worth-it";
}

/** Below this the journal is small enough that a rewrite costs more than it saves. */
const COMPACT_MIN_BYTES = 4 << 20;
/** Growth since the last rewrite that earns another one. */
const COMPACT_GROWTH_BYTES = 32 << 20;
/** A rewrite replaces the file only if it comes out under this fraction of it. */
const COMPACT_KEEP_RATIO = 0.75;
/** A session this long without a write is quiet enough to rebuild its journal under. */
const COMPACT_QUIET_MS = 5_000;

/**
 * Log-structured persistence for the session storage protocol: every accepted commit
 * appends one JSON line, and load replays the journal into memory. The journal is the
 * whole truth — truncating to any line boundary is a valid historical state (append-only,
 * crash-safe by construction).
 *
 * Replay is total because of that: a journal holding one entry id twice — two servers over
 * one directory, or an interrupted tool result committed again when its real output arrived
 * — replays to the later write instead of refusing to open the session. Truncation tolerance
 * and duplicate tolerance are the same property, seen from either end of the file.
 *
 * The same property licenses compaction. A journal rebuilt from the state it produced is a
 * journal: entries and usage rows it still holds, values and list elements still alive, and
 * nothing already overwritten. Without that, an append-only log only ever grows, and the
 * transient state of a finished response — one line per streamed frame — outlives the
 * response by orders of magnitude.
 */
export class FileStorage implements Storage {
	private readonly path: string;
	private readonly memory: MemoryStorage;
	private readonly compactOnLoad: boolean;
	private readonly compactMinBytes: number;
	private readonly compactGrowthBytes: number;
	private readonly compactQuietMs: number;
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
	/** What the journal held the last time it was rebuilt, to decide when to do it again. */
	private bytesAtLastCompact = 0;
	private lastContext: Context | undefined;
	private lastAppendAt = 0;
	private compactScheduled = false;

	private constructor(options: FileStorageOptions) {
		this.path = options.path;
		this.wallClock = options.now ?? Date.now;
		this.compactOnLoad = options.compactOnLoad ?? true;
		this.compactMinBytes = options.compactMinBytes ?? COMPACT_MIN_BYTES;
		this.compactGrowthBytes = options.compactGrowthBytes ?? COMPACT_GROWTH_BYTES;
		this.compactQuietMs = options.compactQuietMs ?? COMPACT_QUIET_MS;
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
		storage.bytesAtLastCompact = size;
		storage.lastContext = context;
		const ids = new Set<string>();
		const parents = new Map<string, string | null>();
		const lines = raw.split("\n");
		const encoder = new TextEncoder();
		let repeated = 0;
		/** Bytes up through the last line the replay accepted, and bytes that no longer parse. */
		let goodBytes = 0;
		let brokenBytes = 0;
		let lastGoodLine = -1;
		let lastBrokenLine = -1;
		storage.replaying = true;
		try {
			for (let index = 0; index < lines.length; index += 1) {
				const line = lines[index]!;
				const trimmed = line.trim();
				if (trimmed.length === 0) continue;
				// Counted with the newline that ended it; the file's last line has none, so the
				// running total is clamped to the size the read actually had.
				const lineBytes = encoder.encode(line).length + 1;
				let entry: JournalLine;
				try {
					entry = JSON.parse(trimmed) as JournalLine;
				} catch {
					// A process died mid-append, or a second writer cut a line in half. The
					// journal is append-only and every accepted commit is a whole line, so the
					// unreadable line is a hole rather than the end of the file: keeping the
					// commits behind it costs nothing, and dropping them loses real history to
					// bytes that were never a state anyone agreed to.
					brokenBytes += lineBytes;
					lastBrokenLine = index;
					continue;
				}
				lastGoodLine = index;
				goodBytes = Math.min(goodBytes + lineBytes, size);
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
		// A hole only matters when the journal goes on behind it; a torn tail is the common
		// shape and is repaired by cutting, which is cheaper than rebuilding everything.
		if (brokenBytes > 0) await storage.repair(goodBytes, lastBrokenLine > lastGoodLine, size, context);
		else if (storage.compactOnLoad && size >= storage.compactMinBytes) await storage.compact(context);
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

	/**
	 * Make the file say what was replayed: cut a torn tail, or rebuild the whole journal when
	 * the damage sits in the middle of it. The repair is written and fsynced, not just applied
	 * to this process's view — a repair that never reaches the disk fails the next open the
	 * same way, which is the failure it exists to fix.
	 */
	private async repair(keptBytes: number, trailingOnly: boolean, readSize: number, context: Context): Promise<void> {
		if (!trailingOnly) {
			const result = await this.rewrite(context, true);
			if (result.rewritten)
				console.warn(
					`[eta-journal] ${this.path}: unreadable bytes inside the journal, rebuilt it from the state it produced (${result.beforeBytes} → ${result.afterBytes} bytes)`,
				);
			else if (result.reason === "concurrent-writer")
				console.warn(`[eta-journal] ${this.path}: unreadable bytes and a concurrent writer, leaving it alone`);
			return;
		}
		const currentSize = await stat(this.path).then(
			(stats) => stats.size,
			() => -1,
		);
		if (currentSize !== readSize) {
			// Someone else is already writing past what we read; truncating would cut them off.
			console.warn(`[eta-journal] ${this.path}: unreadable tail and a concurrent writer, leaving it alone`);
			return;
		}
		const handle = await open(this.path, "r+");
		try {
			await handle.truncate(keptBytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		this.journalBytes = keptBytes;
		this.bytesAtLastCompact = keptBytes;
		console.warn(
			`[eta-journal] ${this.path}: dropped ${readSize - keptBytes} unreadable trailing bytes, the journal resumes there`,
		);
	}

	/**
	 * Replace the journal with one rebuilt from the live state: committed entries, usage
	 * rows, and the values and list elements still alive. Everything a later write replaced —
	 * each frame of a finished response, each superseded value, each deleted list — has
	 * nothing left to say.
	 *
	 * The new journal is written beside the old one and fsynced, renamed over it, and the
	 * directory fsynced, so a crash at any point leaves either the whole old file or the
	 * whole new one. Entry sequence numbers are reassigned in the same relative order, so a
	 * caller holding a paging cursor from before the rewrite may see one window land
	 * differently; nothing persisted refers to a sequence number.
	 */
	async compact(context: Context): Promise<FileStorageCompaction> {
		const result = await this.rewrite(context, false);
		if (result.rewritten)
			console.warn(
				`[eta-journal] ${this.path}: journal rebuilt from live state ${result.beforeBytes} → ${result.afterBytes} bytes`,
			);
		return result;
	}

	private async rewrite(context: Context, force: boolean): Promise<FileStorageCompaction> {
		this.assertOpen();
		// No append may land between reading the state and swapping the file in, and no commit
		// may sit between its memory write and its append, or the rewrite would hold that write
		// twice — once from the state, once from the log it is about to erase.
		const step = this.appendQueue.then(async () => {
			const beforeBytes = await stat(this.path).then(
				(stats) => stats.size,
				() => 0,
			);
			if (beforeBytes !== this.journalBytes) {
				// Another writer appended since this instance last looked. Its lines are not in
				// the state being written, so renaming would silently drop them.
				return { beforeBytes, afterBytes: beforeBytes, rewritten: false, reason: "concurrent-writer" as const };
			}
			const lines = await this.memory.journalFromState(context);
			const payload = Buffer.from(
				lines.map((line) => `${JSON.stringify({ w: line.writes, t: line.timestamp })}\n`).join(""),
				"utf8",
			);
			const afterBytes = payload.byteLength;
			if (!force && afterBytes > beforeBytes * COMPACT_KEEP_RATIO)
				return { beforeBytes, afterBytes, rewritten: false, reason: "not-worth-it" as const };
			const temp = `${this.path}.rewrite`;
			const handle = await open(temp, "w");
			try {
				await handle.writeFile(payload);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temp, this.path);
			// The rename is only durable once the directory is synced too. macOS will not open a
			// directory read-write, but a read-only handle fsyncs it fine. Windows cannot fsync a
			// directory at all, so the rename remains the durability boundary there.
			if (process.platform !== "win32") {
				const directory = await open(dirname(this.path), "r");
				try {
					await directory.sync();
				} finally {
					await directory.close();
				}
			}
			this.journalBytes = afterBytes;
			this.bytesAtLastCompact = afterBytes;
			return { beforeBytes, afterBytes, rewritten: true };
		});
		this.appendQueue = step.then(
			() => undefined,
			() => undefined,
		);
		return step;
	}

	/**
	 * A long-lived session is where the journal actually grows, so growth itself triggers the
	 * rebuild — once the session has been quiet long enough that the rewrite is not paid for
	 * mid-stream.
	 */
	private scheduleCompactAfter(growthBytes: number): void {
		if (this.state !== "open" || this.compactScheduled) return;
		const context = this.lastContext;
		if (context === undefined || this.compactGrowthBytes === 0 || growthBytes < this.compactGrowthBytes) return;
		this.compactScheduled = true;
		const arm = (quietSince: number) => {
			const timer = setTimeout(() => {
				this.compactScheduled = false;
				if (this.state !== "open") return;
				if (this.lastAppendAt > quietSince) {
					// Still writing: try again after another quiet window rather than compacting
					// under a running stream.
					this.compactScheduled = growthBytes < this.journalBytes - this.bytesAtLastCompact;
					if (this.compactScheduled) arm(this.lastAppendAt);
					return;
				}
				void this.compact(context).catch(() => undefined);
			}, this.compactQuietMs);
			timer.unref?.();
		};
		arm(this.lastAppendAt);
	}

	/**
	 * The memory commit and the journal append are one step: split apart, a rewrite queued
	 * between them would capture the write in the state and again in the appended line.
	 */
	async commit(writes: Write[], context: Context): Promise<CommitResult> {
		this.assertOpen();
		this.lastContext = context;
		const step = this.appendQueue.then(async () => {
			const result = await this.memory.commit(writes, context);
			await this.appendLine({ w: writes, t: result.timestamp });
			return result;
		});
		this.appendQueue = step.then(
			() => undefined,
			() => undefined,
		);
		return step;
	}

	/** Append one accepted commit; runs inside `appendQueue`, so appends never interleave. */
	private async appendLine(line: JournalLine): Promise<void> {
		const bytes = new TextEncoder().encode(JSON.stringify(line) + "\n");
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
		this.lastAppendAt = Date.now();
		this.scheduleCompactAfter(this.journalBytes - this.bytesAtLastCompact);
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
