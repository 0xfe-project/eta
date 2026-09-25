/**
 * StorageService — the durability seam (REFACTOR.md §K5).
 *
 * The runner emits ordered events; a storage subscriber persists them here
 * without blocking the loop. Everything crossing this seam is plain data:
 * core knows nothing about files, paths, or line formats, and a backend is
 * free to be a database, a socket, or a test array.
 *
 * Durability rules the implementation owes the caller (learned the hard way,
 * REFACTOR.md §7 / memory):
 * - an append that resolves must survive a crash: fsync, not page cache;
 * - `compactJournal` rebuilds the journal from the state the journal produced
 *   and swaps it atomically, so a crash leaves either the whole old file or
 *   the whole new one;
 * - `repairTornTail` scans the whole journal and skips bad lines instead of
 *   stopping at the first one, so damage in the middle does not silently
 *   delete the history behind it.
 */
import type { Entry } from "../types/entries.ts";

/** One atomic unit of history: entries plus the state writes that came with them. */
export interface JournalCommit {
	/** Entries in causal order — every parent appears before its child. */
	entries: Entry[];
	/** Key/value writes applied in the same commit (last write wins). */
	values?: Record<string, unknown> | undefined;
	/** Keys removed by this commit. */
	deletes?: string[] | undefined;
}

/** Result of `compactJournal`; `rewritten: false` means the backend declined. */
export interface CompactResult {
	rewritten: boolean;
	beforeBytes: number;
	afterBytes: number;
	/** Why a compaction did not happen, when it did not. */
	reason?: string | undefined;
}

/** Result of `repairTornTail`; the repair must be durable before it resolves. */
export interface RepairResult {
	/** Bytes removed from the journal. */
	droppedBytes: number;
	/** Lines that did not parse, anywhere in the journal. */
	droppedRecords: number;
	/** True when the damage was only at the end (a crash mid-append). */
	trailingOnly: boolean;
}

/** The durability contract a backend implements. */
export interface StorageService {
	/** Append a commit. Resolves once it is durable (or queued ahead of `flush`). */
	append(commit: JournalCommit): Promise<void>;

	/** Every commit still held, in append order, for replay into live state. */
	readJournal(): Promise<JournalCommit[]>;

	/** Rewrite the journal from the state it produced, atomically. */
	compactJournal(): Promise<CompactResult>;

	/** Remove bytes that no longer parse, so a torn tail cannot block startup. */
	repairTornTail(): Promise<RepairResult>;

	/** Current value for a key, or undefined. */
	get(key: string): Promise<unknown | undefined>;
	/** Store a value. Applied to the read view immediately, durable at `flush`. */
	set(key: string, value: unknown): Promise<void>;
	/** Remove a key. */
	remove(key: string): Promise<void>;
	/** Keys currently held. */
	keys(): Promise<string[]>;

	/** Block until everything appended or set is durable. */
	flush(): Promise<void>;
	/** Flush and release the backend. Idempotent. */
	close(): Promise<void>;
}

/** The method surface, asserted in tests so the seam cannot drift silently. */
export const STORAGE_METHODS = [
	"append",
	"close",
	"compactJournal",
	"flush",
	"get",
	"keys",
	"readJournal",
	"remove",
	"repairTornTail",
	"set",
] as const satisfies readonly (keyof StorageService)[];

/** Compile-time completeness: every StorageService method is listed above. */
type _StorageMethodsComplete = Exclude<keyof StorageService, (typeof STORAGE_METHODS)[number]> extends never
	? true
	: { missing: Exclude<keyof StorageService, (typeof STORAGE_METHODS)[number]> };
const _storageMethodsComplete: _StorageMethodsComplete = true;
void _storageMethodsComplete;
