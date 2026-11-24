/**
 * Logos kept in the host's database. Storage only: what is read back is somebody else's bytes, and
 * `Logos` checks them again before it hands them on. When the rows together are over the cap, the
 * ones used longest ago go first. One connection, synchronous statements: writes from the four
 * lookups that run at once are taken one after the other.
 */
import type { Database } from "bun:sqlite";

export interface IconRow {
  status: "hit" | "miss";
  mime: string | null;
  bytes: Uint8Array | null;
  expiresAt: number;
}

export interface IconCacheOptions {
  maxTotalBytes?: number;
  maxRows?: number;
}

export class IconCache {
  readonly #db: Database;
  readonly #maxTotal: number;
  readonly #maxRows: number;

  constructor(db: Database, options: IconCacheOptions = {}) {
    this.#db = db;
    this.#maxTotal = options.maxTotalBytes ?? 20 * 1024 * 1024;
    this.#maxRows = options.maxRows ?? 2000;
  }

  get(
    repo: string,
    ref: string,
    path: string,
    now: number,
  ): IconRow | undefined {
    const row = this.#db
      .query(
        "SELECT status, mime, data, expires_at FROM plugin_icon WHERE repo = ? AND ref = ? AND path = ?",
      )
      .get(repo, ref, path) as {
      status: string;
      mime: string | null;
      data: Uint8Array | null;
      expires_at: number;
    } | null;
    if (row === null || (row.status !== "hit" && row.status !== "miss"))
      return undefined;
    this.#db
      .query(
        "UPDATE plugin_icon SET used_at = ? WHERE repo = ? AND ref = ? AND path = ?",
      )
      .run(now, repo, ref, path);
    return {
      status: row.status,
      mime: row.mime,
      bytes: row.data,
      expiresAt: row.expires_at,
    };
  }

  /** Like `get`, but writes nothing (not even the last-used time): for a read that must stay a pure read. */
  peek(repo: string, ref: string, path: string): IconRow | undefined {
    const row = this.#db
      .query(
        "SELECT status, mime, data, expires_at FROM plugin_icon WHERE repo = ? AND ref = ? AND path = ?",
      )
      .get(repo, ref, path) as {
      status: string;
      mime: string | null;
      data: Uint8Array | null;
      expires_at: number;
    } | null;
    if (row === null || (row.status !== "hit" && row.status !== "miss"))
      return undefined;
    return {
      status: row.status,
      mime: row.mime,
      bytes: row.data,
      expiresAt: row.expires_at,
    };
  }

  put(
    repo: string,
    ref: string,
    path: string,
    picture: { mime: string; bytes: Uint8Array } | null,
    expiresAt: number,
    now: number,
  ): void {
    const size = picture?.bytes.byteLength ?? 0;
    this.#db
      .query(
        `INSERT INTO plugin_icon (repo, ref, path, status, mime, data, fetched_at, expires_at, used_at, size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, ref, path) DO UPDATE SET status = excluded.status, mime = excluded.mime,
           data = excluded.data, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at,
           used_at = excluded.used_at, size = excluded.size`,
      )
      .run(
        repo,
        ref,
        path,
        picture ? "hit" : "miss",
        picture?.mime ?? null,
        picture?.bytes ?? null,
        now,
        expiresAt,
        now,
        size,
      );
    this.#evict(repo, ref, path);
  }

  delete(repo: string, ref: string, path: string): void {
    this.#db
      .query("DELETE FROM plugin_icon WHERE repo = ? AND ref = ? AND path = ?")
      .run(repo, ref, path);
  }

  clear(): number {
    return this.#db.query("DELETE FROM plugin_icon").run().changes;
  }

  #evict(repo: string, ref: string, path: string): void {
    for (;;) {
      const total = this.#db
        .query(
          "SELECT COUNT(*) AS rows, COALESCE(SUM(size), 0) AS bytes FROM plugin_icon",
        )
        .get() as { rows: number; bytes: number };
      if (total.rows <= this.#maxRows && total.bytes <= this.#maxTotal) return;
      const oldest = this.#db
        .query(
          "SELECT repo, ref, path FROM plugin_icon WHERE NOT (repo = ? AND ref = ? AND path = ?) ORDER BY used_at ASC LIMIT 1",
        )
        .get(repo, ref, path) as {
        repo: string;
        ref: string;
        path: string;
      } | null;
      if (oldest === null) return;
      this.delete(oldest.repo, oldest.ref, oldest.path);
    }
  }
}
