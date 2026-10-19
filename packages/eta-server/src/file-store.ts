/**
 * The file-backed SessionStore: one directory per session.
 *
 * ```
 * <root>/<id>/meta.json      — what a sidebar needs, without opening anything
 * <root>/<id>/journal.jsonl  — the journal, in the JSONL format §4 pins
 * ```
 *
 * Metadata sits beside the journal so listing costs one small read per session
 * instead of a replay, and so a journal that cannot be read can still be *listed*
 * with the reason — the rule the seam was built around.
 *
 * The store is deliberately boring about damage: a `meta.json` that is missing or
 * unparseable becomes a row with a reason, not a missing session, and its
 * timestamp falls back to the directory's own mtime so the row still sorts
 * sensibly. Opening what cannot be read throws; listing never does.
 *
 * And it remembers where it came from. The old host wrote `meta.json` too, but in
 * its own schema — `personaId`/`modelId`, and no `id`, because the directory was
 * the id. Those sessions are the user's work, so this store reads the old words,
 * maps every one of them, and writes the file back in its schema the first time
 * it sees one. A directory with no `meta.json` at all is the other migration: the
 * journal's first line remembers when the session was made and what it ran on,
 * and the store writes that down — while the folder, which nothing on disk
 * records, falls back to the store's own and is reported as such.
 */

import type { StorageService } from "@eta/core/storage";
import type { JsonlStorageOptions } from "@eta/storage-jsonl";
import type {
  SessionListing,
  SessionMeta,
  SessionStore,
  StoredSession,
} from "./store";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { JsonlStorage } from "@eta/storage-jsonl";

export interface FileSessionStoreOptions {
  /** The directory that holds every session's own directory. */
  root: string;
  /** Human-readable diagnostics (a bad meta, a session that will not parse). */
  warn?: ((message: string) => void) | undefined;
  /** Passed through to each journal (`fsync`, `compactOnLoad`, …). */
  storage?: JsonlStorageOptions | undefined;
  /**
   * The folder a session with no memory of one is assumed to work in. Only a directory whose
   * `meta.json` is missing has this problem: the journal remembers a session's age and its
   * model, never its folder. Defaults to the process's own working directory — what the old
   * host fell back to — and a session that took it is reported through `warn`.
   */
  fallbackCwd?: string | undefined;
}

export const META_FILE = "meta.json";
export const JOURNAL_FILE = "journal.jsonl";

export class FileSessionStore implements SessionStore {
  private readonly root: string;
  private readonly warn: (message: string) => void;
  private readonly storageOptions: FileSessionStoreOptions["storage"];
  private readonly fallbackCwd: string;
  /** Journals this store opened, so it can close them rather than leaving them to the collector. */
  private readonly openStorages = new Map<string, StorageService>();
  private closed = false;

  constructor(options: FileSessionStoreOptions) {
    this.root = options.root;
    this.warn = options.warn ?? (() => undefined);
    this.storageOptions = options.storage;
    this.fallbackCwd = options.fallbackCwd ?? process.cwd();
  }

  async create(meta: SessionMeta): Promise<StoredSession> {
    this.assertOpen();
    const directory = this.directoryOf(meta.id);
    await mkdir(this.root, { recursive: true });
    // `mkdir` without `recursive` is the duplicate check: a session id that is
    // already there is an error, not a silent overwrite of someone's history.
    await mkdir(directory);
    await this.writeMeta(directory, meta);
    const storage = await this.openStorage(directory, meta.id);
    this.openStorages.set(meta.id, storage);
    return { meta, storage };
  }

  async open(id: string): Promise<StoredSession | undefined> {
    this.assertOpen();
    const directory = this.directoryOf(id);
    // No directory at all is an answer, not an error: that session was never here.
    if ((await stat(directory).catch(() => undefined)) === undefined)
      return undefined;
    const meta = await this.metaFor(directory, id);
    // One journal per session per store: opening it twice would mean two
    // independent replays of the same file and two handles nobody closes.
    const existing = this.openStorages.get(id);
    if (existing !== undefined) return { meta, storage: existing };
    const storage = await this.openStorage(directory, id);
    this.openStorages.set(id, storage);
    return { meta, storage };
  }

  async list(): Promise<SessionListing[]> {
    this.assertOpen();
    const entries = await readdir(this.root, { withFileTypes: true }).catch(
      () => [],
    );
    const listings: SessionListing[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      const directory = this.directoryOf(id);
      try {
        const meta = await this.metaFor(directory, id);
        listings.push({ ok: true, id, meta });
      } catch (error) {
        // A directory that is not a session keeps its row, with the reason in words
        // a user can act on. Listing never throws over one bad directory.
        const reason =
          error instanceof MissingSession
            ? error.reason
            : await this.explain(directory);
        this.warn(`[eta-server] session ${id} cannot be read: ${reason}`);
        listings.push({ ok: false, id, reason });
      }
    }
    return listings.sort((a, b) => listingTime(b) - listingTime(a));
  }

  async save(meta: SessionMeta): Promise<boolean> {
    this.assertOpen();
    const directory = this.directoryOf(meta.id);
    if ((await stat(directory).catch(() => undefined)) === undefined)
      return false;
    await this.writeMeta(directory, meta);
    return true;
  }

  async remove(id: string): Promise<boolean> {
    this.assertOpen();
    const directory = this.directoryOf(id);
    const before = await stat(directory).catch(() => undefined);
    if (before === undefined) return false;
    // Close the journal before deleting the directory under it: an open handle to
    // a removed file is a leak the runtime reports as an error later, far from here.
    await this.openStorages.get(id)?.close();
    this.openStorages.delete(id);
    await rm(directory, { recursive: true, force: true });
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    const open = [...this.openStorages.values()];
    this.openStorages.clear();
    for (const storage of open) await storage.close();
  }

  /**
   * Write the metadata beside the journal, atomically: a listing must never read a
   * half-written file (it would look like a broken session), and it must never read
   * the old row either — a rename is one event, not two.
   */
  private async writeMeta(directory: string, meta: SessionMeta): Promise<void> {
    const temporary = join(directory, `${META_FILE}.tmp`);
    await writeFile(temporary, `${JSON.stringify(meta, null, "\t")}\n`, "utf8");
    await rename(temporary, join(directory, META_FILE));
  }

  /** A journal for one session's directory, replayed and ready to write. */
  private async openStorage(
    directory: string,
    id: string,
  ): Promise<StorageService> {
    const storage = await JsonlStorage.open(join(directory, JOURNAL_FILE), {
      ...this.storageOptions,
      warn: (message: string) => this.warn(`[eta-server] ${id}: ${message}`),
    });
    return storage;
  }

  private directoryOf(id: string): string {
    // The id is a name from the caller; keeping it to one path segment is what
    // stops `../..` from writing a journal over something else.
    if (
      id.length === 0 ||
      id.includes("/") ||
      id.includes("\\") ||
      id === "." ||
      id === ".."
    ) {
      throw new Error(`invalid session id: ${JSON.stringify(id)}`);
    }
    return join(this.root, id);
  }

  private async readMeta(directory: string): Promise<SessionMeta | undefined> {
    let raw: string;
    try {
      raw = await readFile(join(directory, META_FILE), "utf8");
    } catch {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return isSessionMeta(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The metadata one directory stands for — read, translated, or rebuilt, and
   * written back in this store's schema whenever it was not already in it.
   *
   * Throws (`MissingSession`) for a directory that is not a session at all; the
   * reason is what a row shows instead of the session.
   */
  private async metaFor(directory: string, id: string): Promise<SessionMeta> {
    const raw = await readFile(join(directory, META_FILE), "utf8").catch(
      () => undefined,
    );
    if (raw !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      if (isSessionMeta(parsed)) return parsed;
      const translated = legacyMeta(parsed, id);
      if (translated !== undefined) {
        // One rewrite per session, ever: the next read finds its own words and
        // leaves them alone. Bookkeeping — the translation is the fix, so a
        // write that fails is reported and the session carries on.
        await this.writeBack(
          directory,
          translated,
          `wrote ${META_FILE} in this store's schema (it was the old host's)`,
        );
        return translated;
      }
      // A `meta.json` that is there but says nothing this store recognizes is
      // left exactly as it is — overwriting what cannot be read is how a recoverable
      // file becomes an unrecoverable one.
      throw new MissingSession(await this.explain(directory));
    }
    // No metadata at all: a session from before the file, or one that arrived as
    // a bare journal. The journal remembers the age and the model; nothing on disk
    // remembers the folder, so the folder falls back and the row says so.
    const synthesized = await this.synthesize(directory, id);
    if (synthesized === undefined) {
      throw new MissingSession(
        `${META_FILE} is missing, and there is no ${JOURNAL_FILE} to rebuild it from`,
      );
    }
    await this.writeBack(
      directory,
      synthesized,
      `had no ${META_FILE}; wrote one from its journal (working folder: ${synthesized.cwd})`,
    );
    return synthesized;
  }

  /** Write metadata the store had to derive, once, and say what it was. */
  private async writeBack(
    directory: string,
    meta: SessionMeta,
    why: string,
  ): Promise<void> {
    try {
      await this.writeMeta(directory, meta);
      this.warn(`[eta-server] session ${meta.id}: ${why}`);
    } catch (error) {
      this.warn(
        `[eta-server] session ${meta.id}: could not write ${META_FILE}: ${String(error)}`,
      );
    }
  }

  /** What a bare journal still says about its session: when it started, and on what model. */
  private async synthesize(
    directory: string,
    id: string,
  ): Promise<SessionMeta | undefined> {
    const journal = await stat(join(directory, JOURNAL_FILE)).catch(
      () => undefined,
    );
    // No journal either: a directory is not a session because it looks like one.
    if (journal === undefined) return undefined;
    const opening = await journalFirstLine(join(directory, JOURNAL_FILE));
    const createdAt =
      (typeof opening?.t === "number" ? opening.t : undefined) ??
      (await stat(directory).catch(() => undefined))?.mtimeMs ??
      Date.now();
    const model =
      opening === undefined ? undefined : journalModel(opening.writes);
    return {
      id,
      createdAt,
      cwd: this.fallbackCwd,
      ...(model === undefined ? {} : { model }),
    };
  }

  /** Why a directory is not a session, in words a user can act on. */
  private async explain(directory: string): Promise<string> {
    let raw: string;
    try {
      raw = await readFile(join(directory, META_FILE), "utf8");
    } catch {
      return "meta.json is missing";
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null)
        return "meta.json is not an object";
      if (!isSessionMeta(parsed))
        return "meta.json has no id, createdAt or cwd";
      return "meta.json is unreadable";
    } catch {
      return "meta.json is not valid JSON";
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("session store is closed");
  }
}

/** The timestamp a row sorts by; a broken row still needs one. */
function listingTime(listing: SessionListing): number {
  return listing.ok ? listing.meta.createdAt : 0;
}

/** A directory that is not a session, and why — thrown inside the store, a reason outside it. */
class MissingSession extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * The old host's `meta.json`, mapped onto this one: `personaId`/`modelId`, and no `id`,
 * because the directory was the id. Only a file that really is one is mapped — a blob that
 * could be anything stays unreadable and keeps its reason, and so does the old host's file
 * when it is missing the two things every one of them had: a creation time and a folder.
 */
function legacyMeta(raw: unknown, id: string): SessionMeta | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.id === "string") return undefined; // this store's schema; its own checks own it
  if (typeof record.createdAt !== "number" || typeof record.cwd !== "string")
    return undefined;
  const meta: SessionMeta = {
    id,
    createdAt: record.createdAt,
    cwd: record.cwd,
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof record.personaId === "string"
      ? { persona: record.personaId }
      : {}),
    ...(typeof record.modelId === "string" ? { model: record.modelId } : {}),
    ...(typeof record.pinned === "boolean" ? { pinned: record.pinned } : {}),
    ...(typeof record.archived === "boolean"
      ? { archived: record.archived }
      : {}),
  };
  return isSessionMeta(meta) ? meta : undefined;
}

/**
 * The journal's first line: both hosts opened a session by writing its clock and its
 * configuration there, which makes it the one thing a bare journal still answers.
 */
async function journalFirstLine(
  path: string,
): Promise<{ t: number; writes: unknown[] } | undefined> {
  const handle = await open(path, "r").catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    const buffer = new Uint8Array(65_536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const at = buffer.subarray(0, bytesRead).indexOf(0x0a);
    const line = new TextDecoder().decode(
      buffer.subarray(0, at === -1 ? bytesRead : at),
    );
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as { t?: unknown; w?: unknown };
    if (!Array.isArray(record.w)) return undefined;
    return { t: typeof record.t === "number" ? record.t : 0, writes: record.w };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/** The model the opening configuration recorded, as `provider:modelId` — either host's namespace. */
function journalModel(writes: readonly unknown[]): string | undefined {
  for (const write of writes) {
    const record = write as {
      kind?: unknown;
      op?: unknown;
      namespace?: unknown;
      value?: unknown;
    };
    if (record.kind !== "value" || record.op !== "set") continue;
    if (
      record.namespace !== "eta.session.config" &&
      record.namespace !== "pi.lane.config"
    )
      continue;
    const model = (
      record.value as
        | { model?: { provider?: unknown; modelId?: unknown } }
        | undefined
    )?.model;
    if (
      typeof model?.provider === "string" &&
      typeof model.modelId === "string"
    ) {
      return `${model.provider}:${model.modelId}`;
    }
  }
  return undefined;
}

function isSessionMeta(value: unknown): value is SessionMeta {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as Partial<SessionMeta>;
  return (
    typeof meta.id === "string" &&
    typeof meta.createdAt === "number" &&
    typeof meta.cwd === "string" &&
    (meta.title === undefined || typeof meta.title === "string") &&
    (meta.persona === undefined || typeof meta.persona === "string") &&
    (meta.model === undefined || typeof meta.model === "string") &&
    (meta.pinned === undefined || typeof meta.pinned === "boolean") &&
    (meta.archived === undefined || typeof meta.archived === "boolean")
  );
}
