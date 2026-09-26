/**
 * MemoryStorage — the in-process StorageService (REFACTOR.md §4).
 *
 * All semantics live in InMemoryStorageState; this class is the async seam
 * around it. Used by tests, by throwaway sessions, and as the reference every
 * other backend is checked against. Nothing here is durable by design.
 */
import type { Entry } from "../types/entries.ts";
import { InMemoryStorageState } from "./state.ts";
import type {
	CommitResult,
	CompactResult,
	EntryScan,
	RepairResult,
	SessionStats,
	StorageBranchScan,
	StorageService,
	StorageWrite,
	StoredValue,
	UsageRow,
	UsageScan,
	Value,
} from "./types.ts";

export class MemoryStorage implements StorageService {
	private readonly state = new InMemoryStorageState();
	private closed = false;
	private bytes = 0;

	/** Repeated entry/usage ids seen, forwarded from the shared state. */
	get repeated(): number {
		return this.state.repeated;
	}

	async commit(writes: StorageWrite[]): Promise<CommitResult> {
		this.assertOpen();
		this.bytes += writes.length * 64;
		return this.state.commit(writes);
	}

	async getEntries(ids: string[]): Promise<Map<string, Entry>> {
		return this.state.getEntries(ids);
	}

	async getValue<T>(address: Value<T>): Promise<StoredValue<T> | undefined> {
		return this.state.getValue(address);
	}

	async listValues<T>(prefix: Value<T>): Promise<StoredValue<T>[]> {
		return this.state.listValues(prefix);
	}

	async scanBranch(query: StorageBranchScan): Promise<Entry[]> {
		return this.state.scanBranch(query);
	}

	async scanEntries(query: EntryScan): Promise<Entry[]> {
		return this.state.scanEntries(query);
	}

	async scanUsage(query: UsageScan): Promise<UsageRow[]> {
		return this.state.scanUsage(query);
	}

	async getStats(): Promise<SessionStats> {
		return this.state.getStats();
	}

	async compactJournal(): Promise<CompactResult> {
		this.assertOpen();
		const beforeBytes = this.bytes;
		const alive = this.state.currentWrites().length;
		this.bytes = Math.max(1, alive * 48);
		return { rewritten: true, beforeBytes, afterBytes: this.bytes };
	}

	/** Nothing tears in memory; the shape exists so backends stay interchangeable. */
	async repairTornTail(): Promise<RepairResult> {
		return { droppedBytes: 0, droppedRecords: 0, trailingOnly: true };
	}

	async flush(): Promise<void> {}

	async close(): Promise<void> {
		this.closed = true;
	}

	/** Bytes a real journal of this state would occupy. */
	journalBytes(): number {
		return this.bytes;
	}

	/** The underlying state, for tests that need to inspect it directly. */
	get internalState(): InMemoryStorageState {
		return this.state;
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("MemoryStorage: closed");
	}
}
