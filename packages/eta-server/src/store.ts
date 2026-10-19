/**
 * Where sessions live — the store seam (REFACTOR.md §5b).
 *
 * Metadata lives *beside* the journal, not inside it, because a sidebar lists
 * sessions it has never opened: an id, when it was made, which directory it works
 * in, and optionally a title, the persona it was left on, and the model. Reading
 * the journal to render a list would make listing as expensive as opening.
 *
 * One rule shapes the whole interface: **a session that cannot be read keeps its
 * row, with a reason.** A store that drops what it cannot parse turns a bug into
 * a disappearance — the user sees their work gone, with no way to ask why. So
 * `list()` answers with rows that are either a session or a reason, and never
 * silently omits one.
 */
import type { StorageService } from "@eta/core/storage";

/** What a sidebar needs about a session without opening it. */
export interface SessionMeta {
  id: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  /** The project this session works in. */
  cwd: string;
  title?: string | undefined;
  /** The persona card it was left on. */
  persona?: string | undefined;
  /** The model it was left on, as `provider:modelId`. */
  model?: string | undefined;
  /**
   * The agent whose session this is, and the conversation it is held in. A host that runs one
   * session per (agent x conversation) names both here, so the mapping survives a restart in the
   * same file as the rest of the row; a bare session carries neither.
   */
  agentId?: string | undefined;
  conversationId?: string | undefined;
  /** Kept at the top of the sidebar. */
  pinned?: boolean | undefined;
  /** Put out of the way without being deleted. */
  archived?: boolean | undefined;
}

/** A session the store can open: its metadata and the journal it writes to. */
export interface StoredSession {
  meta: SessionMeta;
  storage: StorageService;
}

/** One row of a session list: a session, or why one could not be read. */
export type SessionListing =
  | { ok: true; id: string; meta: SessionMeta }
  | { ok: false; id: string; reason: string };

/** What a store starts with: the sessions a restart would have found. */
export type SessionSeed =
  | { meta: SessionMeta; storage?: StorageService }
  | { id: string; broken: string };

export interface SessionStore {
  /** Put a new session in the store, with the metadata the caller chose. */
  create: (meta: SessionMeta) => Promise<StoredSession>;
  /** Open one by id; `undefined` when there is no such session. */
  open: (id: string) => Promise<StoredSession | undefined>;
  /** Every session, newest first, including the ones that cannot be read. */
  list: () => Promise<SessionListing[]>;
  /**
   * Update a session's row — a rename, a pin, an archive. `false` when there is no
   * such session: a caller saving metadata for a session that is gone has raced a
   * deletion, and that is an answer rather than an exception.
   *
   * The journal is untouched: this is what a sidebar reads, and it must stay cheap.
   */
  save: (meta: SessionMeta) => Promise<boolean>;
  /** Forget a session and everything it held. */
  remove: (id: string) => Promise<boolean>;
  /** Stop holding anything open. */
  close: () => Promise<void>;
}
