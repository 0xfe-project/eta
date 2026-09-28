/**
 * @eta/server — many sessions, one process.
 *
 * The harness answers "what does one session need to run". The server answers
 * "how do several of them live together": where a session's metadata and journal
 * come from, which ones are open right now, and what happens to the others when
 * one of them is closed.
 *
 * The shape it is being built toward, in order:
 * - a `SessionStore` seam (`meta.json`-shaped metadata beside a storage handle)
 *   with a memory implementation first, so the seam is exercised before the disk
 *   is;
 * - a `SessionManager` that opens sessions through the harness's `openSession`
 *   and keeps them apart: each session has its own kernel, bus, journal and
 *   usage, and closing one leaves the rest running;
 * - a file-backed store, where a restart finds what the last run left behind.
 *
 * Session metadata lives beside the journal rather than inside it because a
 * sidebar needs to list sessions it has not opened: id, creation time, working
 * directory, and optionally a title, persona and model. A session that cannot be
 * read is listed *with its reason* — a session must never silently disappear.
 */

export { FileSessionStore, type FileSessionStoreOptions, JOURNAL_FILE, META_FILE } from "./file-store";
export {
	type CreateSessionOptions,
	type ManagedSession,
	newSessionId,
	SessionManager,
	type SessionManagerOptions,
} from "./manager";
export { MemorySessionStore, type SessionStorageFactory } from "./memory-store";
export type {
	SessionListing,
	SessionMeta,
	SessionSeed,
	SessionStore,
	StoredSession,
} from "./store";
