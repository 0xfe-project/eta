/**
 * MemorySessionStore — sessions in a Map.
 *
 * The first implementation, and the one the contract runs against: storage
 * starts as bare memory (REFACTOR.md §5b), so the seam is exercised before the
 * filesystem is involved. Each session gets its *own* storage instance — that is
 * the isolation the server is for, and it is tested rather than assumed.
 */

import type {
  SessionListing,
  SessionMeta,
  SessionStore,
  StoredSession,
} from "./store";
import { MemoryStorage } from "@eta/core/storage";

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly broken = new Map<string, string>();
  private closed = false;

  async create(meta: SessionMeta): Promise<StoredSession> {
    if (this.closed) throw new Error("the session store is closed");
    if (this.sessions.has(meta.id) || this.broken.has(meta.id)) {
      throw new Error(`a session ${meta.id} already exists`);
    }
    const session: StoredSession = { meta, storage: new MemoryStorage() };
    this.sessions.set(meta.id, session);
    return session;
  }

  async open(id: string): Promise<StoredSession | undefined> {
    if (this.closed) throw new Error("the session store is closed");
    return this.sessions.get(id);
  }

  async list(): Promise<SessionListing[]> {
    if (this.closed) throw new Error("the session store is closed");
    const rows: { createdAt: number; row: SessionListing }[] = [];
    for (const session of this.sessions.values()) {
      rows.push({
        createdAt: session.meta.createdAt,
        row: { ok: true, id: session.meta.id, meta: session.meta },
      });
    }
    for (const [id, reason] of this.broken) {
      // A row that cannot be read has no creation time to sort by, so it sorts
      // last rather than disappearing.
      rows.push({
        createdAt: Number.NEGATIVE_INFINITY,
        row: { ok: false, id, reason },
      });
    }
    return rows
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((entry) => entry.row);
  }

  async save(meta: SessionMeta): Promise<boolean> {
    if (this.closed) throw new Error("the session store is closed");
    const existing = this.sessions.get(meta.id);
    // The storage is the session's; only the row changes.
    if (existing === undefined) return false;
    this.sessions.set(meta.id, { meta, storage: existing.storage });
    return true;
  }

  /**
   * Mark one session unreadable, as a real backend does when its metadata will
   * not parse. The session keeps its row in `list()` and loses everything else.
   */
  markUnreadable(id: string, reason: string): boolean {
    if (!this.sessions.delete(id)) return false;
    this.broken.set(id, reason);
    return true;
  }

  async remove(id: string): Promise<boolean> {
    if (this.closed) throw new Error("the session store is closed");
    this.broken.delete(id);
    return this.sessions.delete(id);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
