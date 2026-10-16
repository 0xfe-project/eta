import type { Host } from "../src/host";
/**
 * The database and its migrations (REFACTOR.md §9, P0.4).
 *
 * Two claims: the file lands where the data directory says (and the schema inside it is the
 * migrations'), and running it again does nothing — a migration runner that re-applies is worse
 * than none, because a "CREATE TABLE" that ran twice is how a database and its code stop
 * agreeing. The third claim is the one that is easy to get wrong: a migration that fails
 * half-way leaves nothing behind, not even the record that it ran.
 */
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { databasePath, openDatabase } from "../src/db/database";
import {
  applyMigrations,
  loadMigrations,
  schemaVersion,
} from "../src/db/migrations";
import { assembleHost } from "../src/host";

const roots: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eta-db-"));
  roots.push(root);
  return root;
}

const tables = (db: Database): string[] =>
  (
    db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[]
  )
    .map((row) => row.name)
    .sort();

describe("opening the file", () => {
  it("creates the directory it needs", async () => {
    const dataDir = await scratch();
    const path = databasePath(dataDir);
    const db = await openDatabase(path);
    expect((await stat(path)).isFile()).toBe(true);
    expect(path).toBe(join(dataDir, "db", "eta.sqlite"));
    expect(db.query("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    db.close();
  });
});

describe("the migrations on disk", () => {
  it("are grouped by what they belong to, and apply in that order", async () => {
    const migrations = await loadMigrations();
    expect(migrations.map((migration) => migration.id)).toEqual([
      "agents/0001-agents",
      "groups/0001-groups",

      "groups/0002-reply-status",
      "http/0001-idempotency",
      "usage/0001-usage",
    ]);
    expect(migrations[0]?.sql).toContain("CREATE TABLE agents");
  });

  it("apply once, and are a no-op the second time", async () => {
    const db = await openDatabase(databasePath(await scratch()));
    const migrations = await loadMigrations();

    expect(applyMigrations(db, migrations)).toEqual([
      "agents/0001-agents",
      "groups/0001-groups",

      "groups/0002-reply-status",
      "http/0001-idempotency",
      "usage/0001-usage",
    ]);
    expect(tables(db)).toEqual([
      "agents",
      "chat_group",
      "eta_migrations",
      "group_message",
      "group_participant",
      "group_wake",
      "http_idempotency",
      "usage_hourly",
    ]);
    expect(schemaVersion(db)).toBe("usage/0001-usage");

    // The second run: the same list, nothing applied.
    expect(applyMigrations(db, migrations)).toEqual([]);
    expect(schemaVersion(db)).toBe("usage/0001-usage");
    db.close();
  });

  it("leave nothing behind when one fails half-way", () => {
    const db = new Database(":memory:");
    expect(() =>
      applyMigrations(db, [
        { id: "t/0001", sql: "CREATE TABLE t (x INTEGER)" },
        // Fails: the table is there, so the file and the code disagree.
        { id: "t/0002", sql: "CREATE TABLE t (x INTEGER)" },
      ]),
    ).toThrow();
    // The one that worked is recorded; the one that failed is not, and its transaction is
    // rolled back — which is what makes "migrate again" safe.
    expect(schemaVersion(db)).toBe("t/0001");
    expect(tables(db)).toEqual(["eta_migrations", "t"]);
    db.close();
  });
});

describe("the host's database", () => {
  it("is where the data directory says, and /host reports it", async () => {
    const dataDir = await scratch();
    const host = await assembleHost({
      dataDir,
      port: 0,
      warn: () => undefined,
    });
    hosts.push(host);

    expect(host.db.path).toBe(databasePath(dataDir));
    expect((await stat(host.db.path)).isFile()).toBe(true);
    expect(host.db.applied).toEqual([
      "agents/0001-agents",
      "groups/0001-groups",

      "groups/0002-reply-status",
      "http/0001-idempotency",
      "usage/0001-usage",
    ]);
    expect(tables(host.db.handle)).toContain("agents");

    const body = (await (
      await fetch(`http://127.0.0.1:${host.port}/host`)
    ).json()) as {
      dbPath: string;
      schema: string;
    };
    expect(body.dbPath).toBe(databasePath(dataDir));
    expect(body.schema).toBe("usage/0001-usage");
  });

  it("applies nothing on a second start, and says so", async () => {
    const dataDir = await scratch();
    const first = await assembleHost({
      dataDir,
      port: 0,
      warn: () => undefined,
    });
    await first.close();

    const second = await assembleHost({
      dataDir,
      port: 0,
      warn: () => undefined,
    });
    hosts.push(second);
    expect(second.db.applied).toEqual([]);
    expect(second.db.schema()).toBe("usage/0001-usage");
  });
});
