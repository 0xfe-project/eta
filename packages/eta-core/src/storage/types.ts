/**
 * StorageService — the durability seam (REFACTOR.md §4).
 *
 * The write vocabulary is eta-agent's, scoped to the kernel: a commit is an
 * atomic batch of entry / usage / value writes, exactly like the old
 * `{w: [...], t: ...}` journal lines — an old journal file reads as-is.
 * What is deliberately not here: lanes, durable operations, and pending-frame
 * lists. Those were drive/-era transient state; the kernel journals only what
 * a replay should rebuild from.
 *
 * Durability rules every implementation owes the caller:
 * - a commit that resolves must survive a crash (fsync, not page cache);
 * - `compactJournal` rebuilds from live state and swaps atomically;
 * - `repairTornTail` scans the whole journal, stepping over bad lines instead
 *   of stopping at the first one.
 */

import type { Entry, EntryType, NewEntry } from "../types/entries";
import type { JsonValue } from "../types/json";
import type { Usage } from "../types/messages";

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/** One committed entry. Storage assigns seq and the commit timestamp. */
export interface EntryWrite {
  kind: "entry";
  entry: NewEntry;
}

export interface UsageRow {
  id: string;
  seq: number;
  usage: Usage;
  entryId?: string;
  /** True for corrections (e.g. a provider restated usage after the fact). */
  adjustment: boolean;
  details?: JsonValue;
}

/** One usage measurement, usually per assistant entry. */
export interface UsageWrite {
  kind: "usage";
  row: Omit<UsageRow, "seq">;
}

export interface ValueSetWrite {
  kind: "value";
  op: "set";
  namespace: string;
  key: string;
  value: unknown;
}

export interface ValueDeleteWrite {
  kind: "value";
  op: "delete";
  namespace: string;
  key: string;
}

export type ValueWrite = ValueSetWrite | ValueDeleteWrite;
export type StorageWrite = EntryWrite | UsageWrite | ValueWrite;

/* ------------------------------------------------------------------ */
/* Addresses                                                           */
/* ------------------------------------------------------------------ */

declare const storedValueType: unique symbol;

/**
 * A typed address for one key inside a namespace. Addresses exist so reads
 * carry their type with them and prefix scans stay honest. The brand is
 * phantom: it never exists at runtime (same trick as eta-agent's values.ts).
 */
export interface Value<T> {
  readonly kind: "value";
  readonly namespace: string;
  readonly key: string;
  readonly [storedValueType]?: (value: T) => T;
}

export function value<T>(namespace: string, key = ""): Value<T> {
  return { kind: "value", namespace, key };
}

export function setValue<T>(address: Value<T>, next: T): ValueSetWrite {
  return {
    kind: "value",
    op: "set",
    namespace: address.namespace,
    key: address.key,
    value: next,
  };
}

export function deleteValue<T>(address: Value<T>): ValueDeleteWrite {
  return {
    kind: "value",
    op: "delete",
    namespace: address.namespace,
    key: address.key,
  };
}

export interface StoredValue<T> {
  address: Value<T>;
  value: T;
  seq: number;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export interface SessionStats {
  messageCount: number;
  usage: Usage;
}

export interface CommitResult {
  firstSeq: number;
  seqs: number[];
  timestamp: number;
  /** Session totals immediately after this commit was applied. */
  stats: SessionStats;
}

export interface EntryCursor {
  seq: number;
}

export interface BranchScan {
  start?: string;
  stopAtType?: EntryType;
  stopAtId?: string;
  type?: EntryType;
  order?: "newestFirst" | "oldestFirst";
  limit?: number;
  cursor?: EntryCursor;
}

export type StorageBranchScan = BranchScan & { start: string };

export interface EntryScan {
  type?: EntryType;
  fromSeq?: number;
  toSeq?: number;
  order?: "asc" | "desc";
  limit?: number;
}

export interface UsageScan {
  fromSeq?: number;
  toSeq?: number;
  order?: "asc" | "desc";
  limit?: number;
}

/* ------------------------------------------------------------------ */
/* Maintenance results                                                 */
/* ------------------------------------------------------------------ */

export interface CompactResult {
  rewritten: boolean;
  beforeBytes: number;
  afterBytes: number;
  reason?: string | undefined;
}

export interface RepairResult {
  droppedBytes: number;
  droppedRecords: number;
  trailingOnly: boolean;
}

/* ------------------------------------------------------------------ */
/* The seam                                                            */
/* ------------------------------------------------------------------ */

export interface StorageService {
  /** Apply one atomic batch. Resolves when the batch is durable. */
  commit: (writes: StorageWrite[]) => Promise<CommitResult>;

  getEntries: (ids: string[]) => Promise<Map<string, Entry>>;
  getValue: <T>(address: Value<T>) => Promise<StoredValue<T> | undefined>;
  /** Every value whose address starts with the given namespace (+ key prefix). */
  listValues: <T>(prefix: Value<T>) => Promise<StoredValue<T>[]>;
  /** Walk a branch from an explicit entry; merge entries splice their chains in. */
  scanBranch: (query: StorageBranchScan) => Promise<Entry[]>;
  scanEntries: (query: EntryScan) => Promise<Entry[]>;
  scanUsage: (query: UsageScan) => Promise<UsageRow[]>;
  getStats: () => Promise<SessionStats>;

  compactJournal: () => Promise<CompactResult>;
  repairTornTail: () => Promise<RepairResult>;
  flush: () => Promise<void>;
  close: () => Promise<void>;
}
