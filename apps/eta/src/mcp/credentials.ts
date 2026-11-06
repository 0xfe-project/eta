/**
 * The `credential` table as the MCP library's `CredentialStore`.
 *
 * Every value is JSON sealed under the host's key (`../secret`); a row that does not open (another
 * host's key, or tampering) reads as nothing, so the server needs a new login and nothing worse.
 * The reads are synchronous underneath: the async interface is the library's, and `has` is for the
 * status page, which cannot await.
 */
import type { CredentialKind, CredentialStore } from "@eta/mcp";
import type { Database } from "bun:sqlite";
import type { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { seal, unseal } from "../secret";

const INTEGRATION = "mcp";

export class CredentialRows implements CredentialStore {
  readonly #db: Database;
  readonly #key: Buffer;
  readonly #integration: string;

  constructor(db: Database, key: Buffer, integration = INTEGRATION) {
    this.#db = db;
    this.#key = key;
    this.#integration = integration;
  }

  #read(serverKey: string, kind: string): unknown {
    const row = this.#db
      .query<{ value: Uint8Array }, [string, string, string]>(
        "SELECT value FROM credential WHERE integration = ? AND key = ? AND kind = ?",
      )
      .get(this.#integration, serverKey, kind);
    if (row === null) return undefined;
    const text = unseal(this.#key, row.value);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  /** Whether a credential of this kind is stored and opens. */
  has(serverKey: string, kind: CredentialKind): boolean {
    return this.#read(serverKey, kind) !== undefined;
  }

  get: CredentialStore["get"] = async (serverKey, kind) =>
    this.#read(serverKey, kind) as never;

  set: CredentialStore["set"] = async (serverKey, kind, value) => {
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
        this.#integration,
        serverKey,
        kind,
        seal(this.#key, JSON.stringify(value)),
        now,
        now,
      );
  };

  delete: CredentialStore["delete"] = async (serverKey, kind) => {
    this.#db
      .query(
        "DELETE FROM credential WHERE integration = ? AND key = ? AND kind = ?",
      )
      .run(this.#integration, serverKey, kind);
  };
}
