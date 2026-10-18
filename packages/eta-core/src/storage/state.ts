/**
 * InMemoryStorageState — the session-state machine every backend shares
 * (ported from eta-agent's InMemoryStorageState).
 *
 * A backend's job is durability and replay; the semantics — sequence numbers,
 * stats, repeated-id handling, branch scans with merge splicing — live here
 * once, so MemoryStorage and the JSONL journal cannot drift apart.
 */

import { spliceMergedChain } from "../session/graph";
import type { Entry } from "../types/entries";
import { addUsage, emptyUsage, subtractUsage } from "../types/usage";
import type {
  CommitResult,
  EntryScan,
  SessionStats,
  StorageBranchScan,
  StorageWrite,
  StoredValue,
  UsageRow,
  UsageScan,
  Value,
} from "./types";

function physicalKey(namespace: string, key: string): string {
  return `${namespace}\u0000${key}`;
}

/** Code-point comparison: stable for keys that mix numbers and letters. */
export function compareKeys(left: string, right: string): number {
  const leftCodePoints = Array.from(
    left,
    (character) => character.codePointAt(0)!,
  );
  const rightCodePoints = Array.from(
    right,
    (character) => character.codePointAt(0)!,
  );
  const length = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < length; index++) {
    const difference = leftCodePoints[index]! - rightCodePoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftCodePoints.length - rightCodePoints.length;
}

export class InMemoryStorageState {
  private readonly entries = new Map<string, Entry>();
  private readonly usage = new Map<string, UsageRow>();
  private readonly values = new Map<string, StoredValue<unknown>>();
  private stats: SessionStats = { messageCount: 0, usage: emptyUsage() };
  private seq = 0;
  /** Repeated entry/usage ids seen; a torn or double-written journal shows up here. */
  repeated = 0;

  /** Apply a batch, assigning seqs and the commit timestamp. */
  commit(writes: StorageWrite[], timestamp = Date.now()): CommitResult {
    const seqs: number[] = [];
    for (const write of writes) {
      const writeSeq = ++this.seq;
      seqs.push(writeSeq);
      switch (write.kind) {
        case "entry": {
          const entry = {
            ...write.entry,
            seq: writeSeq,
            timestamp,
          } as unknown as Entry;
          if (this.entries.has(entry.id)) this.repeated += 1;
          else if (entry.type === "message") {
            this.stats = {
              ...this.stats,
              messageCount: this.stats.messageCount + 1,
            };
          }
          this.entries.set(entry.id, entry);
          break;
        }
        case "usage": {
          const row: UsageRow = { ...write.row, seq: writeSeq };
          const previous = this.usage.get(row.id);
          // A repeated usage id is a correction, not another charge.
          if (previous !== undefined) {
            this.repeated += 1;
            this.stats = {
              ...this.stats,
              usage: subtractUsage(this.stats.usage, previous.usage),
            };
          }
          this.usage.set(row.id, row);
          this.stats = {
            ...this.stats,
            usage: addUsage(this.stats.usage, row.usage),
          };
          break;
        }
        case "value": {
          const key = physicalKey(write.namespace, write.key);
          if (write.op === "set") {
            this.values.set(key, {
              address: {
                kind: "value",
                namespace: write.namespace,
                key: write.key,
              },
              value: write.value,
              seq: writeSeq,
            });
          } else {
            this.values.delete(key);
          }
          break;
        }
      }
    }
    return {
      firstSeq: seqs[0] ?? this.seq,
      seqs,
      timestamp,
      stats: structuredClone(this.stats),
    };
  }

  getEntries(ids: string[]): Map<string, Entry> {
    const found = new Map<string, Entry>();
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry !== undefined) found.set(id, structuredClone(entry));
    }
    return found;
  }

  getValue<T>(address: Value<T>): StoredValue<T> | undefined {
    const stored = this.values.get(physicalKey(address.namespace, address.key));
    return stored === undefined
      ? undefined
      : (structuredClone(stored) as StoredValue<T>);
  }

  listValues<T>(prefix: Value<T>): StoredValue<T>[] {
    return [...this.values.values()]
      .filter(
        (stored) =>
          stored.address.namespace === prefix.namespace &&
          stored.address.key.startsWith(prefix.key),
      )
      .sort((left, right) => compareKeys(left.address.key, right.address.key))
      .map((stored) => structuredClone(stored) as StoredValue<T>);
  }

  /** Port of eta-agent's scanBranch: walk parents, splice merges, stop/filter/cursor/limit. */
  scanBranch(query: StorageBranchScan): Entry[] {
    const start = this.entries.get(query.start);
    if (start === undefined)
      throw new Error(`Unknown branch start: ${query.start}`);

    const path: Entry[] = [];
    let entry: Entry | undefined = start;
    while (entry !== undefined) {
      path.push(entry);
      if (entry.parentId === null) break;
      entry = this.entries.get(entry.parentId);
      if (entry === undefined)
        throw new Error(
          `Corrupt branch: missing parent ${path.at(-1)!.parentId}`,
        );
    }
    spliceMergedChain(path, (id) => this.entries.get(id));
    if (query.order === "oldestFirst") path.reverse();

    const stopped: Entry[] = [];
    for (const candidate of path) {
      stopped.push(candidate);
      if (
        candidate.id === query.stopAtId ||
        candidate.type === query.stopAtType
      )
        break;
    }
    const filtered = stopped
      .filter(
        (candidate) =>
          query.type === undefined || candidate.type === query.type,
      )
      .filter(
        (candidate) =>
          query.cursor === undefined ||
          (query.order === "oldestFirst"
            ? candidate.seq > query.cursor.seq
            : candidate.seq < query.cursor.seq),
      );
    const result =
      query.limit === undefined
        ? filtered
        : filtered.slice(0, Math.max(0, query.limit));
    return structuredClone(result);
  }

  scanEntries(query: EntryScan): Entry[] {
    const filtered = [...this.entries.values()]
      .filter((entry) => query.type === undefined || entry.type === query.type)
      .filter(
        (entry) => query.fromSeq === undefined || entry.seq >= query.fromSeq,
      )
      .filter((entry) => query.toSeq === undefined || entry.seq <= query.toSeq)
      .sort((left, right) => left.seq - right.seq);
    if (query.order === "desc") filtered.reverse();
    const result =
      query.limit === undefined ? filtered : filtered.slice(0, query.limit);
    return structuredClone(result);
  }

  scanUsage(query: UsageScan): UsageRow[] {
    const filtered = [...this.usage.values()]
      .filter((row) => query.fromSeq === undefined || row.seq >= query.fromSeq)
      .filter((row) => query.toSeq === undefined || row.seq <= query.toSeq)
      .sort((left, right) => left.seq - right.seq);
    if (query.order === "desc") filtered.reverse();
    const result =
      query.limit === undefined ? filtered : filtered.slice(0, query.limit);
    return structuredClone(result);
  }

  getStats(): SessionStats {
    return structuredClone(this.stats);
  }

  /**
   * The writes that rebuild exactly this state: entries and usage rows in
   * sequence order, then the values that are still alive. Everything that was
   * overwritten or deleted has nothing left to say.
   */
  currentWrites(): StorageWrite[] {
    const writes: (StorageWrite & { seq: number })[] = [];
    for (const entry of this.entries.values()) {
      const { seq, timestamp: _timestamp, ...rest } = entry;
      writes.push({ kind: "entry", entry: rest as never, seq });
    }
    for (const row of this.usage.values()) {
      const { seq, ...rest } = row;
      writes.push({ kind: "usage", row: rest, seq });
    }
    writes.sort((left, right) => left.seq - right.seq);
    const out: StorageWrite[] = writes.map(
      ({ seq: _seq, ...write }) => write as StorageWrite,
    );
    for (const stored of this.values.values()) {
      out.push({
        kind: "value",
        op: "set",
        namespace: stored.address.namespace,
        key: stored.address.key,
        value: stored.value,
      });
    }
    return out;
  }
}
