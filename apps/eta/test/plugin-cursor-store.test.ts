/**
 * Where the Cursor credential is kept: one row of the host's `credential` table (integration
 * "market", key = the source, kind "secret"), sealed under the host's key. The old
 * `cursor_credential` table is not made and not read, even where a database still has it.
 */
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { PluginRows } from "../src/plugins/store";
import { seal } from "../src/secret";

const KEY = Buffer.alloc(32, 1);
const VALUE = "Bearer cursor-credential-0123456789";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function world() {
  const db = openDatabase(":memory:");
  applyMigrations(db, loadMigrations());
  return { db, rows: new PluginRows(db, KEY) };
}

describe("the Cursor credential in the credential table", () => {
  it("reads as nothing before one is saved", () => {
    expect(world().rows.cursorCredential()).toBeUndefined();
  });

  it("reads back the plain text that was saved, and the new one after a second save", () => {
    const { rows } = world();
    rows.saveCursorCredential(VALUE);
    expect(rows.cursorCredential()).toBe(VALUE);
    rows.saveCursorCredential("Bearer another-0123456789");
    expect(rows.cursorCredential()).toBe("Bearer another-0123456789");
  });

  it("is one row: integration market, key cursor, kind secret", () => {
    const { db, rows } = world();
    rows.saveCursorCredential(VALUE);
    rows.saveCursorCredential(`${VALUE}x`);
    expect(
      db
        .query<{ integration: string; key: string; kind: string }, []>(
          "SELECT integration, key, kind FROM credential WHERE integration = 'market'",
        )
        .all(),
    ).toEqual([{ integration: "market", key: "cursor", kind: "secret" }]);
  });

  it("is not readable under another key of the host", () => {
    const { db, rows } = world();
    rows.saveCursorCredential(VALUE);
    expect(
      new PluginRows(db, Buffer.alloc(32, 2)).cursorCredential(),
    ).toBeUndefined();
  });

  it("makes no cursor_credential table on a new database", () => {
    const { db } = world();
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE name = 'cursor_credential'",
        )
        .all(),
    ).toEqual([]);
  });

  it("does not read a cursor_credential row an older database still holds", () => {
    const { db, rows } = world();
    db.exec(
      "CREATE TABLE cursor_credential (id INTEGER PRIMARY KEY, sealed BLOB NOT NULL, updated_at INTEGER NOT NULL)",
    );
    db.query("INSERT INTO cursor_credential VALUES (1, ?, ?)").run(
      seal(KEY, VALUE),
      Date.now(),
    );
    expect(rows.cursorCredential()).toBeUndefined();
    expect(rows.configuredAt("demo")).toBe(0);
  });

  it("moves the stamp a session names when the credential is saved, again when it is saved again", async () => {
    const { rows } = world();
    const unset = rows.configuredAt("demo");
    expect(unset).toBe(0);
    rows.saveCursorCredential(VALUE);
    const first = rows.configuredAt("demo");
    expect(first).toBeGreaterThan(unset);
    await sleep(5);
    rows.saveCursorCredential("Bearer another-0123456789");
    expect(rows.configuredAt("demo")).toBeGreaterThan(first);
  });
});
