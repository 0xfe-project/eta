/**
 * The host's sealed secrets: the key file, AES-256-GCM, and the `credential` table that keeps
 * the MCP servers' OAuth state in it.
 */
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { CredentialRows } from "../src/mcp/credentials";
import { loadSecretKey, seal, unseal } from "../src/secret";
import { tempDir } from "./support/host";

const SECRET = "refresh-token-4f9a8b7c6d5e";

describe("the secret key", () => {
  it("is 32 random bytes in secret.key, private to the user, and the same every time", async () => {
    const dir = await tempDir();
    const key = loadSecretKey(dir);
    expect(key).toHaveLength(32);
    const file = join(dir, "secret.key");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file)).toEqual(key);
    expect(loadSecretKey(dir)).toEqual(key);
    expect(loadSecretKey(await tempDir())).not.toEqual(key);
  });

  it("is made private again if something loosened it", async () => {
    const dir = await tempDir();
    loadSecretKey(dir);
    const file = join(dir, "secret.key");
    await writeFile(file, await readFile(file), { mode: 0o644 });
    loadSecretKey(dir);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe("sealing", () => {
  const key = randomBytes(32);

  it("round-trips, with a new random IV on every write", () => {
    const first = seal(key, SECRET);
    const second = seal(key, SECRET);
    expect(unseal(key, first)).toBe(SECRET);
    expect(unseal(key, second)).toBe(SECRET);
    // iv (12) + tag (16) + ciphertext: the IV differs, so the whole blob does.
    expect(first.length).toBe(12 + 16 + SECRET.length);
    expect(first.subarray(0, 12).equals(second.subarray(0, 12))).toBe(false);
    expect(first.includes(SECRET)).toBe(false);
  });

  it("rejects tampering anywhere in the blob, and another key", () => {
    const sealed = seal(key, SECRET);
    for (const index of [0, 12, 28, sealed.length - 1]) {
      const bent = Buffer.from(sealed);
      bent[index] = bent[index]! ^ 1;
      expect(unseal(key, bent)).toBeUndefined();
    }
    expect(unseal(key, sealed.subarray(0, sealed.length - 1))).toBeUndefined();
    expect(unseal(key, sealed.subarray(0, 20))).toBeUndefined();
    expect(unseal(randomBytes(32), sealed)).toBeUndefined();
  });
});

describe("the credential table", () => {
  async function rows(key = randomBytes(32)) {
    const db = openDatabase(join(await tempDir(), "eta.db"));
    applyMigrations(db, loadMigrations());
    return { db, key, store: new CredentialRows(db, key) };
  }
  const tokens = {
    access_token: "a",
    token_type: "Bearer",
    refresh_token: SECRET,
  };

  it("keeps each kind of a server's state apart and gives back what was put in", async () => {
    const { store } = await rows();
    await store.set("server-1", "tokens", tokens);
    await store.set("server-1", "codeVerifier", "verifier");
    await store.set("server-2", "tokens", { ...tokens, access_token: "b" });
    expect(await store.get("server-1", "tokens")).toEqual(tokens);
    expect(await store.get("server-1", "codeVerifier")).toBe("verifier");
    expect(await store.get("server-2", "tokens")).toMatchObject({
      access_token: "b",
    });
    expect(await store.get("server-1", "clientInformation")).toBeUndefined();
    expect(store.has("server-1", "tokens")).toBe(true);
    expect(store.has("server-3", "tokens")).toBe(false);
  });

  it("replaces a value in place and forgets on delete", async () => {
    const { db, store } = await rows();
    await store.set("s", "tokens", tokens);
    await store.set("s", "tokens", { ...tokens, access_token: "next" });
    expect(await store.get("s", "tokens")).toMatchObject({
      access_token: "next",
    });
    expect(db.query("SELECT COUNT(*) AS n FROM credential").get()).toEqual({
      n: 1,
    });
    await store.delete("s", "tokens");
    expect(await store.get("s", "tokens")).toBeUndefined();
    // Forgetting what is not there is fine.
    await store.delete("s", "tokens");
  });

  it("stores nothing readable, and reads a row it cannot open as nothing", async () => {
    const { db, store } = await rows();
    await store.set("s", "tokens", tokens);
    const row = db
      .query<{ integration: string; value: Uint8Array }, []>(
        "SELECT integration, value FROM credential",
      )
      .get()!;
    expect(row.integration).toBe("mcp");
    expect(Buffer.from(row.value).includes(SECRET)).toBe(false);

    // Another host's key, or a flipped bit: the server simply needs a new login.
    expect(
      await new CredentialRows(db, randomBytes(32)).get("s", "tokens"),
    ).toBeUndefined();
    const bent = Buffer.from(row.value);
    bent[bent.length - 1] = bent[bent.length - 1]! ^ 1;
    db.query("UPDATE credential SET value = ?").run(bent);
    expect(await store.get("s", "tokens")).toBeUndefined();
    expect(store.has("s", "tokens")).toBe(false);
  });
});
