/**
 * MemoryStorage — the in-process StorageService (REFACTOR.md §K5).
 *
 * Same contract as the file-backed one, without the disk: used by tests, by
 * throwaway sessions, and as the reference implementation other backends are
 * checked against. Apples-to-apples with a file journal: every write, entry or
 * KV, goes into the journal as a commit, so `readJournal` of a memory storage
 * replays into a fresh storage exactly like a file's would.
 *
 * Nothing here is durable by design — `flush` resolves immediately because the
 * journal already is the process's own memory.
 */
import type { CompactResult, JournalCommit, RepairResult, StorageService } from "./types.ts";

/** Rough size a backend would report; enough for compaction thresholds in tests. */
const COMMIT_BYTES = 64;
const ENTRY_BYTES = 32;

export class MemoryStorage implements StorageService {
	private commits: JournalCommit[] = [];
	private readonly values = new Map<string, unknown>();
	private closed = false;

	async append(commit: JournalCommit): Promise<void> {
		this.assertOpen();
		this.commits.push(structuredClone(commit));
		this.applyCommit(commit);
	}

	async readJournal(): Promise<JournalCommit[]> {
		return structuredClone(this.commits);
	}

	/** Replace the journal with one commit holding what is still alive. */
	async compactJournal(): Promise<CompactResult> {
		this.assertOpen();
		const entries = this.commits.flatMap((commit) => commit.entries);
		const beforeBytes = this.journalBytes();
		const kept: Record<string, unknown> = {};
		for (const [key, value] of this.values) kept[key] = value;
		this.commits =
			entries.length > 0 || this.values.size > 0
				? [{ entries, ...(Object.keys(kept).length > 0 ? { values: kept } : {}) }]
				: [];
		return { rewritten: true, beforeBytes, afterBytes: this.journalBytes() };
	}

	/** Nothing tears in memory; the shape exists so backends stay interchangeable. */
	async repairTornTail(): Promise<RepairResult> {
		return { droppedBytes: 0, droppedRecords: 0, trailingOnly: true };
	}

	/** Copied out: a caller mutating a value must not rewrite stored state. */
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

	async flush(): Promise<void> {}

	async close(): Promise<void> {
		this.closed = true;
	}

	/** Bytes a real journal of this state would occupy. */
	bytes(): number {
		return this.journalBytes();
	}

	private journalBytes(): number {
		return this.commits.reduce((total, commit) => total + COMMIT_BYTES + commit.entries.length * ENTRY_BYTES, 0);
	}

	private applyCommit(commit: JournalCommit): void {
		if (commit.values !== undefined) {
			for (const [key, value] of Object.entries(commit.values)) this.values.set(key, structuredClone(value));
		}
		if (commit.deletes !== undefined) {
			for (const key of commit.deletes) this.values.delete(key);
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("MemoryStorage: closed");
	}
}
