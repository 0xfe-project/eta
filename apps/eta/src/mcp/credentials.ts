/**
 * The MCP library's `CredentialStore`, over the `credential` table.
 *
 * The table seals and opens the values (`../credentials/table`); a row that does not open reads
 * as nothing, so the server needs a new login and nothing worse. The reads are synchronous
 * underneath: the async methods are the library's, and `has` is for the status page, which cannot
 * await.
 */
import type {
  CredentialKind,
  CredentialRecord,
  CredentialStore,
} from "@eta/mcp";
import type { Database } from "bun:sqlite";
import type { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { EncryptedCredentialTable } from "../credentials/table";

const INTEGRATION = "mcp";

export class CredentialRows implements CredentialStore {
  readonly #table: EncryptedCredentialTable;

  constructor(db: Database, key: Buffer) {
    this.#table = new EncryptedCredentialTable(db, key);
  }

  /** Whether a credential of this kind is stored and opens. */
  has(serverKey: string, kind: CredentialKind): boolean {
    return this.#table.read(INTEGRATION, serverKey, kind) !== undefined;
  }

  /** When this credential was saved (epoch milliseconds); undefined when none is stored. */
  savedAt(serverKey: string, kind: CredentialKind): number | undefined {
    return this.#table.writtenAt(INTEGRATION, serverKey, kind);
  }

  /** A short stamp of the stored value (never the value): changes when a new sign-in is stored. */
  stamp(serverKey: string, kind: CredentialKind): string | undefined {
    const value = this.#table.read(INTEGRATION, serverKey, kind);
    return value === undefined
      ? undefined
      : createHash("sha256")
          .update(JSON.stringify(value))
          .digest("hex")
          .slice(0, 16);
  }

  async get<K extends CredentialKind>(
    serverKey: string,
    kind: K,
  ): Promise<CredentialRecord[K] | undefined> {
    // The value is a CredentialRecord at set; a row that does not open is undefined.
    return this.#table.read(INTEGRATION, serverKey, kind) as
      | CredentialRecord[K]
      | undefined;
  }

  async set<K extends CredentialKind>(
    serverKey: string,
    kind: K,
    value: CredentialRecord[K],
  ): Promise<void> {
    this.#table.write(INTEGRATION, serverKey, kind, value);
  }

  async delete(serverKey: string, kind: CredentialKind): Promise<void> {
    this.#table.erase(INTEGRATION, serverKey, kind);
  }
}
