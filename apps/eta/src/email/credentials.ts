import type { Database } from "bun:sqlite";
import type { Buffer } from "node:buffer";
import { EncryptedCredentialTable } from "../credentials/table";

const INTEGRATION = "email";
const KIND = "password";

/** The mailbox password or app-specific token, sealed under the host key. */
export class EmailCredentials {
  readonly #table: EncryptedCredentialTable;

  constructor(db: Database, key: Buffer) {
    this.#table = new EncryptedCredentialTable(db, key);
  }

  async get(accountId: string): Promise<string | undefined> {
    return passwordOf(this.#table.read(INTEGRATION, accountId, KIND));
  }

  async set(accountId: string, password: string): Promise<void> {
    this.#table.write(INTEGRATION, accountId, KIND, { password });
  }

  async delete(accountId: string): Promise<void> {
    this.#table.erase(INTEGRATION, accountId, KIND);
  }
}

function passwordOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { password } = value as { password?: unknown };
  return typeof password === "string" ? password : undefined;
}
