/**
 * The `credential` table: one row per (integration, owner, kind), its value sealed under the
 * host's key (`../secret`). What a value means belongs to the feature that wrote it; this only
 * stores and opens it, and a row that does not open reads as nothing.
 */
import type { Database } from "bun:sqlite";
import type { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { seal, unseal } from "../secret";

export class EncryptedCredentialTable {
  readonly #db: Database;
  readonly #key: Buffer;

  constructor(db: Database, key: Buffer) {
    this.#db = db;
    this.#key = key;
  }

  /** The value stored under this row, or `undefined` when there is none or it does not open. */
  read(integration: string, owner: string, kind: string): unknown {
    const row = this.#db
      .query<{ value: Uint8Array }, [string, string, string]>(
        "SELECT value FROM credential WHERE integration = ? AND key = ? AND kind = ?",
      )
      .get(integration, owner, kind);
    if (row === null) return undefined;
    const text = unseal(this.#key, row.value);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  /** When the row was last written (epoch milliseconds), or `undefined` when there is none. */
  writtenAt(
    integration: string,
    owner: string,
    kind: string,
  ): number | undefined {
    return this.#db
      .query<{ updated_at: number }, [string, string, string]>(
        "SELECT updated_at FROM credential WHERE integration = ? AND key = ? AND kind = ?",
      )
      .get(integration, owner, kind)?.updated_at;
  }

  write(
    integration: string,
    owner: string,
    kind: string,
    value: unknown,
  ): void {
    const now = Date.now();
    this.#db
      .query(
        `INSERT INTO credential (id, integration, key, kind, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (integration, key, kind)
         DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(
        randomUUID(),
        integration,
        owner,
        kind,
        seal(this.#key, JSON.stringify(value)),
        now,
        now,
      );
  }

  erase(integration: string, owner: string, kind: string): void {
    this.#db
      .query(
        "DELETE FROM credential WHERE integration = ? AND key = ? AND kind = ?",
      )
      .run(integration, owner, kind);
  }
}
