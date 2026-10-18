/**
 * JSONL session journal — the file-backed StorageService (REFACTOR.md §4).
 *
 * One commit per line, in the same wire format eta-agent journals use:
 * `{ "w": [...writes], "t": timestamp }`. An old journal reads as-is; the
 * kernel vocabulary is a subset of the old one (no list writes, no op state),
 * so the same line format carries both.
 *
 * Three rules this file exists to enforce, each learned from a real failure:
 * 1. A commit that resolved must survive a crash: write then fsync.
 * 2. A line that does not parse is a hole, not the end of the file: the repair
 *    scans the whole journal and skips bad lines instead of stopping at the
 *    first one.
 * 3. Compaction rebuilds the journal from live state and swaps it atomically —
 *    write beside, fsync, rename, fsync the directory — so a crash leaves the
 *    whole old journal or the whole new one.
 */

import type {
  CommitResult,
  CompactResult,
  Entry,
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
} from "@eta/core/storage";
import { open, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import { InMemoryStorageState } from "@eta/core/storage";

export interface JsonlStorageOptions {
  /**
   * fsync after every commit. Default true; a caller that would rather lose
   * the last line than pay the syscall can turn it off and call `flush`.
   */
  fsyncOnCommit?: boolean;
  /** Compact during `open` once the journal passes `compactMinBytes`. */
  compactOnLoad?: boolean;
  /** Byte threshold for `compactOnLoad`. Default 256 KiB. */
  compactMinBytes?: number;
  /** Called with human-readable diagnostics (repairs, skipped lines). */
  warn?: (message: string) => void;
}

const DEFAULT_COMPACT_MIN_BYTES = 256 * 1024;

/** One journal line on disk: the writes, and the commit timestamp. */
interface JournalLine {
  w: StorageWrite[];
  t: number;
}

/** A parsed line, narrowed to the writes this kernel understands. */
interface ParsedLine {
  writes: StorageWrite[];
  t: number;
}

export class JsonlStorage implements StorageService {
  readonly path: string;

  private readonly options: JsonlStorageOptions;
  private readonly state = new InMemoryStorageState();
  private handle: Awaited<ReturnType<typeof open>> | undefined;
  private dirty = false;
  private closed = false;
  private journalBytes = 0;
  private pendingRepair = {
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
  static async open(
    path: string,
    options: JsonlStorageOptions = {},
  ): Promise<JsonlStorage> {
    const storage = new JsonlStorage(path, options);
    let raw: string;
    let size = 0;
    try {
      raw = await readFileText(path);
      size = (await stat(path)).size;
    } catch (error) {
      if (isNotFound(error)) return storage;
      throw error;
    }

    // Every line is examined: a hole in the middle costs nothing to step over,
    // and the commits behind it are history somebody agreed to.
    const parsed = parseLines(raw);
    for (const line of parsed.lines) {
      if (line.writes.length === 0) continue;
      storage.state.commit(line.writes, line.t);
    }
    for (const [what, count] of Object.entries(parsed.skipped)) {
      options.warn?.(
        `[eta-journal] ${path}: skipped ${count} write(s) this kernel does not use (${what})`,
      );
    }
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
    if (storage.state.repeated > 0) {
      options.warn?.(
        `[eta-journal] ${path}: ${storage.state.repeated} repeated entry/usage id(s), kept the last write of each`,
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

  /** Apply one atomic batch: assign seqs, append one line, fsync. */
  async commit(writes: StorageWrite[]): Promise<CommitResult> {
    this.assertOpen();
    const result = this.state.commit(writes);
    const line = `${JSON.stringify({ w: writes, t: result.timestamp } satisfies JournalLine)}\n`;
    const handle = await this.appendHandle();
    await handle.write(line);
    this.dirty = true;
    if (this.options.fsyncOnCommit !== false) {
      await handle.sync();
      this.dirty = false;
    }
    this.journalBytes += new TextEncoder().encode(line).length;
    return result;
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

  /**
   * Make the file say what was replayed. Damage at the end is cut; damage in
   * the middle rebuilds the journal from the state that survived, because
   * there is no single byte to truncate at. Either way the result is fsynced —
   * a repair that never reaches disk fails the next open the same way.
   */
  async repairTornTail(): Promise<RepairResult> {
    this.assertOpen();
    const { keptBytes, brokenBytes, brokenRecords, trailingOnly } =
      this.pendingRepair;
    if (brokenRecords === 0)
      return { droppedBytes: 0, droppedRecords: 0, trailingOnly: true };

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
      this.pendingRepair = {
        keptBytes,
        brokenBytes: 0,
        brokenRecords: 0,
        trailingOnly: true,
      };
      return {
        droppedBytes: brokenBytes,
        droppedRecords: brokenRecords,
        trailingOnly: true,
      };
    }

    const compacted = await this.compactJournal();
    this.pendingRepair = {
      keptBytes: compacted.afterBytes,
      brokenBytes: 0,
      brokenRecords: 0,
      trailingOnly: false,
    };
    return {
      droppedBytes: brokenBytes,
      droppedRecords: brokenRecords,
      trailingOnly: false,
    };
  }

  /**
   * Replace the journal with one rebuilt from live state: the entries and
   * usage rows still held, in sequence order, then the values that are still
   * alive. Everything superseded has nothing left to say.
   */
  async compactJournal(): Promise<CompactResult> {
    this.assertOpen();
    const beforeBytes = this.journalBytes;
    const writes = this.state.currentWrites();
    if (writes.length === 0 && beforeBytes === 0) {
      return {
        rewritten: false,
        beforeBytes: 0,
        afterBytes: 0,
        reason: "empty journal",
      };
    }
    const content =
      writes.length === 0
        ? ""
        : `${JSON.stringify({ w: writes, t: Date.now() } satisfies JournalLine)}\n`;
    const afterBytes = new TextEncoder().encode(content).length;
    await this.writeAtomic(content);
    return { rewritten: true, beforeBytes, afterBytes };
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
  async reopen(
    options: JsonlStorageOptions = this.options,
  ): Promise<JsonlStorage> {
    return JsonlStorage.open(this.path, options);
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
    this.journalBytes =
      content.length === 0 ? 0 : new TextEncoder().encode(content).length;
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

  private assertOpen(): void {
    if (this.closed) throw new Error("JsonlStorage: closed");
  }
}

interface ParsedJournal {
  lines: ParsedLine[];
  badLineIndexes: Set<number>;
  /** Writes present in the file but not part of a kernel session. */
  skipped: Record<string, number>;
  keptBytes: number;
  brokenBytes: number;
  trailingOnly: boolean;
}

/** Parse a journal body, stepping over holes instead of stopping at them. */
function parseLines(raw: string): ParsedJournal {
  const encoder = new TextEncoder();
  const lines: ParsedLine[] = [];
  const badLineIndexes = new Set<number>();
  const skipped: Record<string, number> = {};
  let keptBytes = 0;
  let brokenBytes = 0;
  let lastGoodLine = -1;
  let lastBrokenLine = -1;
  const split = raw.split("\n");
  for (let index = 0; index < split.length; index += 1) {
    const line = split[index]!;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Counted with the newline that ended it; the file's last line has none.
    const lineBytes =
      encoder.encode(line).length + (index === split.length - 1 ? 0 : 1);
    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(trimmed);
    } catch {
      badLineIndexes.add(index);
      brokenBytes += lineBytes;
      lastBrokenLine = index;
      continue;
    }
    const parsedLineSplit = splitLine(parsedLine);
    if (parsedLineSplit === undefined) {
      badLineIndexes.add(index);
      brokenBytes += lineBytes;
      lastBrokenLine = index;
      continue;
    }
    for (const [what, count] of Object.entries(parsedLineSplit.skipped)) {
      skipped[what] = (skipped[what] ?? 0) + count;
    }
    lastGoodLine = index;
    lines.push(parsedLineSplit.line);
    keptBytes += lineBytes;
  }
  return {
    lines,
    badLineIndexes,
    skipped,
    keptBytes,
    brokenBytes,
    trailingOnly: lastBrokenLine > lastGoodLine,
  };
}

/**
 * Value namespaces a kernel session keeps. eta-agent's own state (`eta.*`) and
 * the two session-level addresses are data; everything else under `pi.` was
 * drive- or lane-era bookkeeping (operation state, pending frames, branch
 * tips) that this design does not have and must not resurrect on import.
 */
const KEPT_VALUE_NAMESPACES = ["pi.entry.label", "pi.session.name"];

function keepsValue(namespace: string): boolean {
  // Not a reserved address: it belongs to whoever wrote it (a session, a
  // plugin, the battery's own `eta.*` state).
  if (!namespace.startsWith("pi.")) return true;
  return KEPT_VALUE_NAMESPACES.includes(namespace);
}

/**
 * Split one journal line into the writes a kernel session understands.
 *
 * A line is damage only when it does not parse at all or `w` is not an array.
 * A write whose kind or namespace belongs to machinery this design deleted is
 * skipped and counted: an old journal must stay readable, and one unknown write
 * must not cost the entries sitting beside it on the same line.
 */
function splitLine(
  value: unknown,
): { line: ParsedLine; skipped: Record<string, number> } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as { w?: unknown; t?: unknown };
  if (!Array.isArray(raw.w)) return undefined;
  const writes: StorageWrite[] = [];
  const skipped: Record<string, number> = {};
  const skip = (what: string): void => {
    skipped[what] = (skipped[what] ?? 0) + 1;
  };
  for (const write of raw.w) {
    if (typeof write !== "object" || write === null) {
      skip("malformed");
      continue;
    }
    const kind = (write as { kind?: unknown }).kind;
    if (kind === "entry") {
      const entry = (write as { entry?: { id?: unknown } }).entry;
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.id === "string"
      ) {
        writes.push(write as StorageWrite);
      } else {
        skip("malformed entry");
      }
      continue;
    }
    if (kind === "usage") {
      const row = (write as { row?: { id?: unknown } }).row;
      if (
        typeof row === "object" &&
        row !== null &&
        typeof row.id === "string"
      ) {
        writes.push(write as StorageWrite);
      } else {
        skip("malformed usage");
      }
      continue;
    }
    if (kind === "value") {
      const op = (write as { op?: unknown }).op;
      const namespace = (write as { namespace?: unknown }).namespace;
      if (op !== "set" && op !== "delete") {
        skip("malformed value");
        continue;
      }
      if (typeof namespace !== "string" || !keepsValue(namespace)) {
        skip(`value:${typeof namespace === "string" ? namespace : "unknown"}`);
        continue;
      }
      writes.push(write as StorageWrite);
      continue;
    }
    // `list` writes and anything else a future journal adds.
    skip(typeof kind === "string" ? kind : "unknown write");
  }
  return {
    line: { writes, t: typeof raw.t === "number" ? raw.t : 0 },
    skipped,
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ENOENT"
  );
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
