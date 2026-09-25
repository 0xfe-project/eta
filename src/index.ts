/**
 * JSONL session journal — the file-backed StorageService (REFACTOR.md §K5).
 *
 * One commit per line, append-only. Three rules this file exists to enforce,
 * each learned from a real failure:
 *
 * 1. An append that resolved must survive a crash: write then fsync, so the
 *    repair is not just sitting in the page cache.
 * 2. A line that does not parse is a hole, not the end of the file. The repair
 *    scans the whole journal and skips bad lines; stopping at the first one
 *    would silently delete the history behind it.
 * 3. Compaction rebuilds the journal from the state it produced and swaps it
 *    in atomically — write beside, fsync, rename, fsync the directory — so a
 *    crash leaves either the whole old journal or the whole new one.
 *
 * The wire format is one JSON object per line: `{ entries, values?, deletes? }`.
 */
import { open, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { CompactResult, JournalCommit, RepairResult, StorageService } from "@eta/core";

export interface JsonlStorageOptions {
	/**
	 * fsync after every append. Default true; a caller that would rather lose
	 * the last line than pay the syscall can turn it off and call `flush`.
	 */
	fsyncOnAppend?: boolean;
	/** Compact during `open` once the journal passes `compactMinBytes`. */
	compactOnLoad?: boolean;
	/** Byte threshold for `compactOnLoad`. Default 256 KiB. */
	compactMinBytes?: number;
	/** Called with human-readable diagnostics (repairs, skipped lines). */
	warn?: (message: string) => void;
}

const DEFAULT_COMPACT_MIN_BYTES = 256 * 1024;

export class JsonlStorage implements StorageService {
	readonly path: string;

	private readonly options: JsonlStorageOptions;
	private commits: JournalCommit[] = [];
	private readonly values = new Map<string, unknown>();
	private handle: Awaited<ReturnType<typeof open>> | undefined;
	private dirty = false;
	private closed = false;
	/** Bytes the journal had when it was last known-good on disk. */
	private journalBytes = 0;
	/** Damage seen at load, until `repairTornTail` makes the file match memory. */
	private pendingRepair: { keptBytes: number; brokenBytes: number; brokenRecords: number; trailingOnly: boolean } = {
		keptBytes: 0,
		brokenBytes: 0,
		brokenRecords: 0,
		trailingOnly: true,
	};
	private constructor(path: string, options: JsonlStorageOptions) {
		this.path = path;
		this.options = options;
	}

	/** Read the journal without touching the file; damage is reported, not fixed. */
	static async open(path: string, options: JsonlStorageOptions = {}): Promise<JsonlStorage> {
		const storage = new JsonlStorage(path, options);
		let raw: string;
		let size = 0;
		try {
			raw = await readFileText(path);
			size = (await stat(path)).size;
		} catch (error) {
			if (isNotFound(error)) {
				storage.journalBytes = 0;
				return storage;
			}
			throw error;
		}

		// Every line is examined: a hole in the middle costs nothing to step over,
		// and the commits behind it are history somebody agreed to.
		const parsed = parseLines(raw);
		for (const commit of parsed.commits) storage.applyCommit(commit);
		storage.commits = parsed.commits;
		// The file's last line has no newline, so kept bytes are clamped to the
		// size the read actually had.
		const keptBytes = Math.min(parsed.keptBytes, size);

		storage.journalBytes = size;
		storage.pendingRepair = {
			keptBytes,
			brokenBytes: parsed.brokenBytes,
			brokenRecords: parsed.badLineIndexes.size,
			trailingOnly: parsed.trailingOnly,
		};
		if (parsed.badLineIndexes.size > 0) {
			options.warn?.(
				`[eta-journal] ${path}: ${parsed.badLineIndexes.size} unreadable line(s), ${parsed.brokenBytes} byte(s) — call repairTornTail()`,
			);
		}
		if (
			options.compactOnLoad === true &&
			parsed.badLineIndexes.size === 0 &&
			size >= (options.compactMinBytes ?? DEFAULT_COMPACT_MIN_BYTES)
		) {
			await storage.compactJournal();
		}
		return storage;
	}

	async append(commit: JournalCommit): Promise<void> {
		this.assertOpen();
		const line = `${JSON.stringify(commit)}\n`;
		const handle = await this.appendHandle();
		await handle.write(line);
		this.dirty = true;
		if (this.options.fsyncOnAppend !== false) {
			await handle.sync();
			this.dirty = false;
		}
		this.journalBytes += new TextEncoder().encode(line).length;
		this.commits.push(commit);
		this.applyCommit(commit);
	}

	async readJournal(): Promise<JournalCommit[]> {
		return structuredClone(this.commits);
	}

	/**
	 * Make the file say what was replayed. Damage at the end is cut; damage in
	 * the middle rebuilds the journal from the state that survived, because
	 * there is no single byte to truncate at. Either way the result is fsynced —
	 * a repair that never reaches disk fails the next open the same way.
	 */
	async repairTornTail(): Promise<RepairResult> {
		this.assertOpen();
		const { keptBytes, brokenBytes, brokenRecords, trailingOnly } = this.pendingRepair;
		if (brokenRecords === 0) return { droppedBytes: 0, droppedRecords: 0, trailingOnly: true };

		if (trailingOnly) {
			const currentSize = await stat(this.path).then(
				(stats) => stats.size,
				() => -1,
			);
			if (currentSize !== this.journalBytes) {
				this.options.warn?.(
					`[eta-journal] ${this.path}: unreadable tail and a concurrent writer, leaving it alone`,
				);
				return { droppedBytes: 0, droppedRecords: 0, trailingOnly: true };
			}
			await this.closeHandle();
			const handle = await open(this.path, "r+");
			try {
				await handle.truncate(keptBytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
			this.journalBytes = keptBytes;
			this.pendingRepair = { keptBytes, brokenBytes: 0, brokenRecords: 0, trailingOnly: true };
			return { droppedBytes: brokenBytes, droppedRecords: brokenRecords, trailingOnly: true };
		}

		// Damage sits between good commits: rewriting is the only repair that
		// keeps what is behind it.
		const compacted = await this.compactJournal();
		this.pendingRepair = { keptBytes: compacted.afterBytes, brokenBytes: 0, brokenRecords: 0, trailingOnly: false };
		return { droppedBytes: brokenBytes, droppedRecords: brokenRecords, trailingOnly: false };
	}

	/**
	 * Replace the journal with one rebuilt from live state: the entries that
	 * survived and the KV values as they stand now. Every superseded value and
	 * every tombstone has nothing left to say.
	 */
	async compactJournal(): Promise<CompactResult> {
		this.assertOpen();
		const beforeBytes = this.journalBytes;
		const content = this.renderJournal();
		const afterBytes = new TextEncoder().encode(content).length;
		if (content.length === 0 && beforeBytes === 0) {
			return { rewritten: false, beforeBytes: 0, afterBytes: 0, reason: "empty journal" };
		}
		await this.writeAtomic(content);
		// The journal on disk is now the journal: what it holds is what a replay
		// would see, so the in-memory view adopts it.
		this.commits = content.length === 0 ? [] : parseLines(content).commits;
		return { rewritten: true, beforeBytes, afterBytes };
	}

	async get(key: string): Promise<unknown | undefined> {
		const value = this.values.get(key);
		return value === undefined ? undefined : structuredClone(value);
	}

	async set(key: string, value: unknown): Promise<void> {
		await this.append({ entries: [], values: { [key]: value } });
	}

	async remove(key: string): Promise<void> {
		await this.append({ entries: [], deletes: [key] });
	}

	async keys(): Promise<string[]> {
		return [...this.values.keys()];
	}

	async flush(): Promise<void> {
		if (this.closed || this.handle === undefined || !this.dirty) return;
		await this.handle.sync();
		this.dirty = false;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		await this.flush();
		await this.closeHandle();
		this.closed = true;
	}

	/** Bytes currently held on disk. */
	bytes(): number {
		return this.journalBytes;
	}

	/** Open the same journal again, as a fresh process would. */
	async reopen(options: JsonlStorageOptions = this.options): Promise<JsonlStorage> {
		return JsonlStorage.open(this.path, options);
	}

	/**
	 * The compacted journal: every entry still held, in order, one line per
	 * commit that carries entries — and one final line holding the KV state as
	 * it stands. Values that were overwritten or deleted have nothing left to
	 * say, so their commits drop out entirely.
	 */
	private renderJournal(): string {
		const lines: string[] = [];
		for (const commit of this.commits) {
			if (commit.entries.length === 0) continue;
			lines.push(JSON.stringify({ entries: commit.entries }));
		}
		if (this.values.size > 0) {
			const alive: Record<string, unknown> = {};
			for (const [key, value] of this.values) alive[key] = value;
			lines.push(JSON.stringify({ entries: [], values: alive }));
		}
		return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
	}

	private async writeAtomic(content: string): Promise<void> {
		await this.closeHandle();
		const tempPath = `${this.path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
		const handle = await open(tempPath, "w");
		try {
			if (content.length > 0) await handle.write(content);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tempPath, this.path);
		await syncDirectory(dirname(this.path));
		const size = content.length === 0 ? 0 : new TextEncoder().encode(content).length;
		this.journalBytes = size;
	}

	private async appendHandle(): Promise<Awaited<ReturnType<typeof open>>> {
		if (this.handle === undefined) this.handle = await open(this.path, "a");
		return this.handle;
	}

	private async closeHandle(): Promise<void> {
		if (this.handle === undefined) return;
		if (this.dirty) {
			await this.handle.sync();
			this.dirty = false;
		}
		await this.handle.close();
		this.handle = undefined;
	}

	private applyCommit(commit: JournalCommit): void {
		if (commit.values !== undefined) {
			for (const [key, value] of Object.entries(commit.values)) this.values.set(key, value);
		}
		if (commit.deletes !== undefined) {
			for (const key of commit.deletes) this.values.delete(key);
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("JsonlStorage: closed");
	}
}

interface ParsedJournal {
	commits: JournalCommit[];
	/** Indexes of lines that did not parse, in the original file. */
	badLineIndexes: Set<number>;
	/** Bytes up through the last line that parsed. */
	keptBytes: number;
	brokenBytes: number;
	/** Damage sits after the last good line — the common crash-mid-append shape. */
	trailingOnly: boolean;
}

/** Parse a journal body, stepping over holes instead of stopping at them. */
function parseLines(raw: string): ParsedJournal {
	const encoder = new TextEncoder();
	const commits: JournalCommit[] = [];
	const badLineIndexes = new Set<number>();
	let keptBytes = 0;
	let brokenBytes = 0;
	let lastGoodLine = -1;
	let lastBrokenLine = -1;
	const lines = raw.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		// Counted with the newline that ended it; the file's last line has none.
		const lineBytes = encoder.encode(line).length + (index === lines.length - 1 ? 0 : 1);
		let commit: unknown;
		try {
			commit = JSON.parse(trimmed);
		} catch {
			badLineIndexes.add(index);
			brokenBytes += lineBytes;
			lastBrokenLine = index;
			continue;
		}
		if (!isJournalCommit(commit)) {
			badLineIndexes.add(index);
			brokenBytes += lineBytes;
			lastBrokenLine = index;
			continue;
		}
		lastGoodLine = index;
		commits.push(commit);
		keptBytes += lineBytes;
	}
	return { commits, badLineIndexes, keptBytes, brokenBytes, trailingOnly: lastBrokenLine > lastGoodLine };
}

function isJournalCommit(value: unknown): value is JournalCommit {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray((value as { entries?: unknown }).entries) &&
		(value as JournalCommit).entries.every(
			(entry) => typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string",
		)
	);
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

async function readFileText(path: string): Promise<string> {
	const handle = await open(path, "r");
	try {
		const stats = await handle.stat();
		const buffer = new Uint8Array(stats.size);
		await handle.read(buffer, 0, stats.size, 0);
		return new TextDecoder().decode(buffer);
	} finally {
		await handle.close();
	}
}

/**
 * fsync the directory so the rename itself is durable. Directories cannot be
 * opened read-write everywhere, but a read-only handle syncs fine; where even
 * that fails (Windows), the rename is still atomic, just not crash-proof.
 */
async function syncDirectory(path: string): Promise<void> {
	try {
		const handle = await open(path, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch {
		// Best effort on platforms that refuse to sync a directory handle.
	}
}
