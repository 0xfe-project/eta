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
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StorageService } from "@eta/core";
import { JsonlStorage, type JsonlStorageOptions } from "@eta/storage-jsonl";
import type { SessionListing, SessionMeta, SessionStore, StoredSession } from "./store";

export interface FileSessionStoreOptions {
	/** The directory that holds every session's own directory. */
	root: string;
	/** Human-readable diagnostics (a bad meta, a session that will not parse). */
	warn?: ((message: string) => void) | undefined;
	/** Passed through to each journal (`fsync`, `compactOnLoad`, …). */
	storage?: JsonlStorageOptions | undefined;
}

export const META_FILE = "meta.json";
export const JOURNAL_FILE = "journal.jsonl";

export class FileSessionStore implements SessionStore {
	private readonly root: string;
	private readonly warn: (message: string) => void;
	private readonly storageOptions: FileSessionStoreOptions["storage"];
	/** Journals this store opened, so it can close them rather than leaving them to the collector. */
	private readonly openStorages = new Map<string, StorageService>();
	private closed = false;

	constructor(options: FileSessionStoreOptions) {
		this.root = options.root;
		this.warn = options.warn ?? (() => undefined);
		this.storageOptions = options.storage;
	}

	async create(meta: SessionMeta): Promise<StoredSession> {
		this.assertOpen();
		const directory = this.directoryOf(meta.id);
		await mkdir(this.root, { recursive: true });
		// `mkdir` without `recursive` is the duplicate check: a session id that is
		// already there is an error, not a silent overwrite of someone's history.
		await mkdir(directory);
		// Write the metadata beside the journal, atomically: a listing must never
		// read a half-written file (it would look like a broken session).
		const temporary = join(directory, `${META_FILE}.tmp`);
		await writeFile(temporary, `${JSON.stringify(meta, null, "\t")}\n`, "utf8");
		await rename(temporary, join(directory, META_FILE));
		const storage = await this.openStorage(directory, meta.id);
		this.openStorages.set(meta.id, storage);
		return { meta, storage };
	}

	async open(id: string): Promise<StoredSession | undefined> {
		this.assertOpen();
		const directory = this.directoryOf(id);
		// No directory at all is an answer, not an error: that session was never here.
		if ((await stat(directory).catch(() => undefined)) === undefined) return undefined;
		const meta = await this.readMeta(directory);
		if (meta === undefined) {
			// A directory *with* no readable metadata is the other case: the session is
			// there, and saying it is missing would hide it. `list()` shows it with its
			// reason; opening it is the caller's error.
			throw new Error(`session ${id} has no readable meta.json in ${directory}`);
		}
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
		const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
		const listings: SessionListing[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const id = entry.name;
			const directory = this.directoryOf(id);
			const meta = await this.readMeta(directory);
			if (meta !== undefined) {
				listings.push({ ok: true, id, meta });
				continue;
			}
			const reason = await this.explain(directory);
			this.warn(`[eta-server] session ${id} cannot be read: ${reason}`);
			listings.push({ ok: false, id, reason });
		}
		return listings.sort((a, b) => listingTime(b) - listingTime(a));
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

	/** A journal for one session's directory, replayed and ready to write. */
	private async openStorage(directory: string, id: string): Promise<StorageService> {
		const storage = await JsonlStorage.open(join(directory, JOURNAL_FILE), {
			...this.storageOptions,
			warn: (message: string) => this.warn(`[eta-server] ${id}: ${message}`),
		});
		return storage;
	}

	private directoryOf(id: string): string {
		// The id is a name from the caller; keeping it to one path segment is what
		// stops `../..` from writing a journal over something else.
		if (id.length === 0 || id.includes("/") || id.includes("\\") || id === "." || id === "..") {
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
			if (typeof parsed !== "object" || parsed === null) return "meta.json is not an object";
			if (!isSessionMeta(parsed)) return "meta.json has no id, createdAt or cwd";
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

function isSessionMeta(value: unknown): value is SessionMeta {
	if (typeof value !== "object" || value === null) return false;
	const meta = value as Partial<SessionMeta>;
	return (
		typeof meta.id === "string" &&
		typeof meta.createdAt === "number" &&
		typeof meta.cwd === "string" &&
		(meta.title === undefined || typeof meta.title === "string") &&
		(meta.persona === undefined || typeof meta.persona === "string") &&
		(meta.model === undefined || typeof meta.model === "string")
	);
}
