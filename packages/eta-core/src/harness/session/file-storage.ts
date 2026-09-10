import { appendFile, mkdir, readFile } from "node:fs/promises";
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
 */
export class FileStorage implements Storage {
	private readonly path: string;
	private readonly memory: MemoryStorage;
	private appendQueue: Promise<void> = Promise.resolve();
	private state: "open" | "closing" | "closed" = "open";
	private closePromise: Promise<void> | undefined;

	private constructor(options: FileStorageOptions) {
		this.path = options.path;
		this.memory = new MemoryStorage(options.now === undefined ? {} : { now: options.now });
	}

	static async load(options: FileStorageOptions, context: Context): Promise<FileStorage> {
		let raw = "";
		try {
			raw = await readFile(options.path, "utf8");
		} catch {
			raw = "";
		}
		const lines: JournalLine[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			lines.push(JSON.parse(trimmed) as JournalLine);
		}
		let replayAt = Date.now();
		const storage = new FileStorage({ ...options, now: () => replayAt });
		for (const entry of lines) {
			replayAt = entry.t ?? replayAt;
			await storage.memory.commit(entry.w, context);
		}
		return storage;
	}

	async commit(writes: Write[], context: Context): Promise<CommitResult> {
		this.assertOpen();
		const result = await this.memory.commit(writes, context);
		await this.append({ w: writes, t: result.timestamp });
		return result;
	}

	private append(line: JournalLine): Promise<void> {
		const payload = JSON.stringify(line) + "\n";
		const next = this.appendQueue.then(async () => {
			await mkdir(dirname(this.path), { recursive: true });
			await appendFile(this.path, payload);
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
