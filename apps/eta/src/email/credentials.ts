import type { Database } from "bun:sqlite";
import type { Buffer } from "node:buffer";
import { seal, unseal } from "../secret";

/** The mailbox password or app-specific token, sealed under the host key. */
export class EmailCredentials {
  private readonly db: Database;
  private readonly key: Buffer;

  constructor(db: Database, key: Buffer) {
    this.db = db;
    this.key = key;
  }

  async get(accountId: string): Promise<string | undefined> {
    const row = this.db
      .query<{ value: Uint8Array }, [string]>(
        "SELECT value FROM credential WHERE integration='email' AND key=? AND kind='password'",
      )
      .get(accountId);
    if (row === null) return undefined;
    const text = unseal(this.key, row.value);
    if (text === undefined) return undefined;
    try {
      const value = JSON.parse(text) as { password?: unknown };
      return typeof value.password === "string" ? value.password : undefined;
    } catch {
      return undefined;
    }
  }

  async set(accountId: string, password: string): Promise<void> {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO credential (id, integration, key, kind, value, created_at, updated_at)
         VALUES (?, 'email', ?, 'password', ?, ?, ?)
         ON CONFLICT (integration, key, kind) DO UPDATE SET
           value=excluded.value, updated_at=excluded.updated_at`,
      )
      .run(
        crypto.randomUUID(),
        accountId,
        seal(this.key, JSON.stringify({ password })),
        now,
        now,
      );
  }

  async delete(accountId: string): Promise<void> {
    this.db
      .query(
        "DELETE FROM credential WHERE integration='email' AND key=? AND kind='password'",
      )
      .run(accountId);
  }
}
