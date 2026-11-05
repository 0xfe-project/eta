/**
 * The database file and its migration runner. The runner is tested with inline migrations: the
 * product ships no tables yet, and what is under test is the rule, not any one schema.
 */
import type { Database } from "bun:sqlite";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  databasePath,
  loadMigrations,
  openDatabase,
} from "../src/db";
import { embedResources } from "../src/resources";
import { tempDir } from "./support/host";

const open: Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

async function database(): Promise<Database> {
  const db = openDatabase(databasePath(join(await tempDir(), "nested")));
  open.push(db);
  return db;
}

const tables = (db: Database): string[] =>
  db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);

describe("openDatabase", () => {
  it("creates the file and its directory, with WAL, foreign keys and a busy timeout", async () => {
    const db = await database();
    expect(db.query("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  });

  it("enforces foreign keys", async () => {
    const db = await database();
    db.exec("CREATE TABLE a (id INTEGER PRIMARY KEY)");
    db.exec("CREATE TABLE b (a_id INTEGER NOT NULL REFERENCES a (id))");
    expect(() => db.exec("INSERT INTO b (a_id) VALUES (1)")).toThrow(
      /FOREIGN KEY/,
    );
  });
});

describe("applyMigrations", () => {
  const first = { id: "0001-notes", sql: "CREATE TABLE note (id INTEGER)" };
  const second = {
    id: "0002-note-text",
    sql: "ALTER TABLE note ADD COLUMN body TEXT",
  };

  it("applies each migration once, in the order given, and records it", async () => {
    const db = await database();
    expect(applyMigrations(db, [first, second])).toEqual([first.id, second.id]);
    expect(tables(db)).toEqual(["eta_migrations", "note"]);
    expect(
      db
        .query<{ id: string }, []>("SELECT id FROM eta_migrations ORDER BY id")
        .all()
        .map((row) => row.id),
    ).toEqual([first.id, second.id]);

    // A second run has nothing to do, and a later migration is the only thing that runs.
    expect(applyMigrations(db, [first, second])).toEqual([]);
    const third = {
      id: "0003-index",
      sql: "CREATE INDEX note_id ON note (id)",
    };
    expect(applyMigrations(db, [first, second, third])).toEqual([third.id]);
  });

  it("runs on an empty list: the bookkeeping exists, nothing else does", async () => {
    const db = await database();
    expect(applyMigrations(db, [])).toEqual([]);
    expect(tables(db)).toEqual(["eta_migrations"]);
  });

  it("applies a migration entirely or not at all, and does not record a failed one", async () => {
    const db = await database();
    applyMigrations(db, [first]);
    const broken = {
      id: "0002-broken",
      // The first statement is fine; the second cannot run. Neither may stay.
      sql: "CREATE TABLE half (id INTEGER); INSERT INTO missing VALUES (1)",
    };
    expect(() => applyMigrations(db, [first, broken])).toThrow(/missing/);
    expect(tables(db)).toEqual(["eta_migrations", "note"]);
    expect(
      db.query("SELECT 1 FROM eta_migrations WHERE id = ?").get(broken.id),
    ).toBeNull();

    // Fixed under the same id, it applies.
    const fixed = { id: broken.id, sql: "CREATE TABLE half (id INTEGER)" };
    expect(applyMigrations(db, [first, fixed])).toEqual([fixed.id]);
  });

  it("keeps what earlier migrations created when a later one fails", async () => {
    const db = await database();
    const broken = { id: "0002-broken", sql: "SELECT * FROM missing" };
    expect(() => applyMigrations(db, [first, broken])).toThrow();
    expect(tables(db)).toEqual(["eta_migrations", "note"]);
  });
});

describe("two processes on a new database", () => {
  it("apply each migration once", async () => {
    const dir = await tempDir();
    const path = join(dir, "eta.sqlite");
    const program = join(dir, "migrate.ts");
    await writeFile(
      program,
      `import { applyMigrations, loadMigrations, openDatabase } from ${JSON.stringify(resolve(import.meta.dirname, "../src/db.ts"))};
const db = openDatabase(${JSON.stringify(path)});
console.log(applyMigrations(db, loadMigrations()).length);
`,
    );
    const runs = Array.from({ length: 4 }, () =>
      Bun.spawn([process.execPath, program], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const results = await Promise.all(
      runs.map(async (run) => {
        const [stdout, stderr, code] = await Promise.all([
          new Response(run.stdout).text(),
          new Response(run.stderr).text(),
          run.exited,
        ]);
        expect(stderr).toBe("");
        expect(code).toBe(0);
        return Number(stdout);
      }),
    );
    const total = loadMigrations().length;
    expect(results.reduce((sum, count) => sum + count, 0)).toBe(total);
  });
});

describe("loadMigrations", () => {
  it("reads NNNN-<name>.sql files in number order and ignores other files", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "0002-second.sql"), "SELECT 2");
    await writeFile(join(dir, "0001-first.sql"), "SELECT 1");
    await writeFile(join(dir, ".gitkeep"), "");
    expect(loadMigrations(dir)).toEqual([
      { id: "0001-first", sql: "SELECT 1" },
      { id: "0002-second", sql: "SELECT 2" },
    ]);
  });

  it("refuses a file the runner would otherwise skip silently, and a number used twice", async () => {
    const misnamed = await tempDir();
    await writeFile(join(misnamed, "agents.sql"), "SELECT 1");
    expect(() => loadMigrations(misnamed)).toThrow(/NNNN-<name>\.sql/);

    const duplicated = await tempDir();
    await writeFile(join(duplicated, "0001-a.sql"), "SELECT 1");
    await writeFile(join(duplicated, "0001-b.sql"), "SELECT 1");
    expect(() => loadMigrations(duplicated)).toThrow(/0001/);
  });

  it("keeps a migration's original name when the file inside an executable has another", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "0001-first-tsyv6076.sql"), "SELECT 1");
    await writeFile(join(dir, "0002-second-n93k08rt.sql"), "SELECT 2");
    embedResources({
      files: {
        "migrations/0002-second.sql": join(dir, "0002-second-n93k08rt.sql"),
        "migrations/0001-first.sql": join(dir, "0001-first-tsyv6076.sql"),
      },
      digests: {},
    });
    try {
      expect(loadMigrations()).toEqual([
        { id: "0001-first", sql: "SELECT 1" },
        { id: "0002-second", sql: "SELECT 2" },
      ]);
    } finally {
      embedResources(undefined);
    }
  });

  it("loads the migrations this package ships, and they apply", async () => {
    const db = await database();
    const shipped = loadMigrations();
    expect(applyMigrations(db, shipped)).toEqual(shipped.map((m) => m.id));
  });
});
