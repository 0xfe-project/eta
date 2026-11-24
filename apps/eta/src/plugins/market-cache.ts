import type { Database } from "bun:sqlite";
/**
 * The market's catalog cache, in the host's database. A row is one catalog's JSON text with the
 * validators its server gave. The text is somebody else's: the caller checks its shape again on every
 * read, and a row that is too big is dropped here. When the rows together are over the cap, the ones
 * used longest ago go first.
 */
import { Buffer } from "node:buffer";

export interface CachedCatalog {
  text: string;
  etag: string | null;
  lastModified: string | null;
  /** When the server last confirmed this text, in ms. */
  fetchedAt: number;
}

export interface CatalogCacheOptions {
  /** The largest text one row may hold. */
  maxRowBytes: number;
  maxTotalBytes?: number;
  maxRows?: number;
}

export class CatalogCache {
  readonly #db: Database;
  readonly #maxRow: number;
  readonly #maxTotal: number;
  readonly #maxRows: number;

  constructor(db: Database, options: CatalogCacheOptions) {
    this.#db = db;
    this.#maxRow = options.maxRowBytes;
    this.#maxTotal = options.maxTotalBytes ?? 8 * 1024 * 1024;
    this.#maxRows = options.maxRows ?? 20;
  }

  get(url: string, now: number): CachedCatalog | undefined {
    const row = this.#db
      .query(
        "SELECT body, etag, last_modified, fetched_at, size FROM market_catalog_cache WHERE url = ?",
      )
      .get(url) as {
      body: string;
      etag: string | null;
      last_modified: string | null;
      fetched_at: number;
      size: number;
    } | null;
    if (row === null) return undefined;
    if (row.size > this.#maxRow || Buffer.byteLength(row.body) > this.#maxRow) {
      this.delete(url);
      return undefined;
    }
    this.#db
      .query("UPDATE market_catalog_cache SET used_at = ? WHERE url = ?")
      .run(now, url);
    return {
      text: row.body,
      etag: row.etag,
      lastModified: row.last_modified,
      fetchedAt: row.fetched_at,
    };
  }

  /** Keep this text for this address; it replaces what was there. */
  put(
    url: string,
    text: string,
    etag: string | null,
    lastModified: string | null,
    now: number,
  ): void {
    const size = Buffer.byteLength(text);
    if (size > this.#maxRow) return;
    this.#db
      .query(
        `INSERT INTO market_catalog_cache (url, body, etag, last_modified, fetched_at, used_at, size)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET body = excluded.body, etag = excluded.etag,
           last_modified = excluded.last_modified, fetched_at = excluded.fetched_at,
           used_at = excluded.used_at, size = excluded.size`,
      )
      .run(url, text, etag, lastModified, now, now, size);
    this.#evict(url);
  }

  /** The server said "not changed": the same text, confirmed now. */
  confirm(url: string, now: number): void {
    this.#db
      .query(
        "UPDATE market_catalog_cache SET fetched_at = ?, used_at = ? WHERE url = ?",
      )
      .run(now, now, url);
  }

  delete(url: string): void {
    this.#db.query("DELETE FROM market_catalog_cache WHERE url = ?").run(url);
  }

  clear(): number {
    return this.#db.query("DELETE FROM market_catalog_cache").run().changes;
  }

  #evict(keep: string): void {
    for (;;) {
      const total = this.#db
        .query(
          "SELECT COUNT(*) AS rows, COALESCE(SUM(size), 0) AS bytes FROM market_catalog_cache",
        )
        .get() as { rows: number; bytes: number };
      if (total.rows <= this.#maxRows && total.bytes <= this.#maxTotal) return;
      const oldest = this.#db
        .query(
          "SELECT url FROM market_catalog_cache WHERE url <> ? ORDER BY used_at ASC LIMIT 1",
        )
        .get(keep) as { url: string } | null;
      if (oldest === null) return;
      this.delete(oldest.url);
    }
  }
}
