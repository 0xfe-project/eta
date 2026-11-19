/**
 * The product's settings table: a key and a JSON value. This is the only place that reads or
 * writes it; what a setting means is the feature's business, this only keeps it.
 */
import type { Database } from "bun:sqlite";

export class SettingStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** The value under `key`, or `undefined` when it was never set (or what is there is unreadable). */
  get(key: string): unknown {
    const row = this.#db
      .query<{ value: string }, [string]>(
        "SELECT value FROM setting WHERE key = ?",
      )
      .get(key);
    if (row === null) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return undefined;
    }
  }

  set(key: string, value: unknown): void {
    this.#db
      .query(
        `INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  delete(key: string): void {
    this.#db.query("DELETE FROM setting WHERE key = ?").run(key);
  }
}
