import type { CredentialKind, CredentialStore } from "../../src/oauth/index.js";

/** An in-memory CredentialStore; the host's real one is SQLite. */
export function createMemoryCredentialStore(): CredentialStore {
  const rows = new Map<string, string>();
  const key = (serverKey: string, kind: CredentialKind) =>
    `${kind}\0${serverKey}`;
  return {
    get: async (serverKey, kind) => {
      const row = rows.get(key(serverKey, kind));
      return row === undefined ? undefined : JSON.parse(row);
    },
    set: async (serverKey, kind, value) => {
      rows.set(key(serverKey, kind), JSON.stringify(value));
    },
    delete: async (serverKey, kind) => {
      rows.delete(key(serverKey, kind));
    },
  };
}
