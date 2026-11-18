/**
 * 0054, as an upgrade rather than as a fresh install: the shape a v0.3.0 host left behind is this
 * checkout's migrations minus `0054-task-archive`, and a real board's rows must come through it
 * whole — every task, every timeline entry of every kind those migrations allowed, the edges, the
 * indexes the pages read by, and the cascade that takes a task's timeline with it.
 *
 * Nothing here is copied from a person's data: the rows are made by the same INSERTs an old host
 * made, so what the migration sees is the shape, not one board's contents.
 */
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  databasePath,
  loadMigrations,
  openDatabase,
} from "../src/db";
import { tempDir } from "./support/host";

const NEWEST = "0054-task-archive";

// The migrations as far as 0054: what came after it is not this test's business.
const ALL = loadMigrations().filter((migration) => migration.id <= NEWEST);
/** What a v0.3.0 host ran, in order. */
const BEFORE_0054 = ALL.filter((migration) => migration.id < NEWEST);
/** What a host that ran 0054 had: later migrations are their own tests' business. */
const UP_TO_0054 = ALL.filter((migration) => migration.id <= NEWEST);

/**
 * The kinds a 0.3.0 host wrote. 0054 adds `archived` and `unarchived`; the CHECK is why the table
 * has to be made again, so the list is the subject, not a detail.
 */
const OLD_KINDS = [
  "created",
  "comment",
  "status",
  "assignee",
  "title",
  "description",
  "conversation",
  "artifact",
  "run_queued",
  "run_started",
  "run_completed",
  "run_failed",
  "run_interrupted",
  "run_nudged",
  "dependency",
  "parent",
  "subtask",
] as const;

const open: Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

async function oldDatabase(): Promise<Database> {
  const db = openDatabase(databasePath(join(await tempDir(), "eta.sqlite")));
  open.push(db);
  expect(applyMigrations(db, BEFORE_0054).at(-1)).toBe(
    "0053-routines-run-by-captain",
  );
  return db;
}

interface Made {
  parent: string;
  child: string;
  empty: string;
}

/** A board as a 0.3.0 host left it: a task with a subtask, an edge, and an entry of every kind. */
function seed(db: Database): Made {
  const now = Date.now();
  const insert = db.query(
    "INSERT INTO task (id, title, status, created_at, updated_at, parent_id) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insert.run("t-parent", "A parent", "in_progress", now, now, null);
  insert.run("t-child", "A subtask", "todo", now + 1, now + 1, "t-parent");
  insert.run("t-empty", "Never touched", "backlog", now + 2, now + 2, null);

  const entry = db.query(
    "INSERT INTO task_activity (id, task_id, run_id, kind, actor, actor_agent, body, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const [index, kind] of OLD_KINDS.entries())
    entry.run(
      `a-${index}`,
      "t-parent",
      kind.startsWith("run_") ? `r-${index}` : null,
      kind,
      index % 2 === 0 ? "user" : "agent",
      index % 2 === 0 ? null : "ada",
      index % 3 === 0 ? null : `said ${kind} ${index}`,
      JSON.stringify({ index, kind }),
      now + 10 + index,
    );
  // One task nobody ever wrote about, and one whose only entry is a comment.
  entry.run(
    "a-comment",
    "t-child",
    null,
    "comment",
    "user",
    null,
    "hi",
    "{}",
    now + 40,
  );
  db.query(
    "INSERT INTO task_dependency (task_id, depends_on_id, require_done, created_at) VALUES (?, ?, ?, ?)",
  ).run("t-child", "t-parent", 1, now);
  return { parent: "t-parent", child: "t-child", empty: "t-empty" };
}

const count = (db: Database, table: string): number =>
  db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!.n;

const kinds = (db: Database): { kind: string; n: number }[] =>
  db
    .query<{ kind: string; n: number }, []>(
      "SELECT kind, count(*) AS n FROM task_activity GROUP BY kind ORDER BY kind",
    )
    .all();

const columns = (db: Database, table: string): string[] =>
  db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);

const indexes = (db: Database, table: string): string[] =>
  db
    .query<{ name: string }, [string]>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`,
    )
    .all(table)
    .map((row) => row.name);

/** Every stored field of every entry, as text: what "the rows came through" has to mean. */
const entries = (db: Database): string[] =>
  db
    .query<Record<string, unknown>, []>(
      "SELECT id, task_id, run_id, kind, actor, actor_agent, body, data, created_at FROM task_activity ORDER BY id",
    )
    .all()
    .map((row) => JSON.stringify(row));

describe("0054 as an upgrade", () => {
  it("adds the archive columns and rebuilds the timeline without losing a row", async () => {
    const db = await oldDatabase();
    const made = seed(db);
    const before = {
      tasks: count(db, "task"),
      activity: count(db, "task_activity"),
      kinds: kinds(db),
      entries: entries(db),
    };
    // Nothing archived can be written before the migration, whatever anyone tries.
    expect(columns(db, "task")).not.toContain("archived_at");

    expect(applyMigrations(db, UP_TO_0054)).toEqual([NEWEST]);

    expect(columns(db, "task")).toEqual(
      expect.arrayContaining(["archived_at", "archived_by"]),
    );
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM task WHERE archived_at IS NOT NULL OR archived_by IS NOT NULL",
        )
        .get()!.n,
    ).toBe(0);

    // The rows, field for field, in the order they were written.
    expect(count(db, "task")).toBe(before.tasks);
    expect(count(db, "task_activity")).toBe(before.activity);
    expect(entries(db)).toEqual(before.entries);
    expect(kinds(db)).toEqual(before.kinds);
    expect(kinds(db).map((row) => row.kind)).toEqual([...OLD_KINDS].sort());

    // The rebuilt table takes the two kinds it was rebuilt for, and still refuses a kind nothing
    // writes: the CHECK came along with the table.
    db.query(
      "INSERT INTO task_activity (id, task_id, kind, actor, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("a-archived", made.parent, "archived", "system", "{}", Date.now());
    expect(() =>
      db
        .query(
          "INSERT INTO task_activity (id, task_id, kind, actor, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("a-bogus", made.parent, "not-a-kind", "system", "{}", Date.now()),
    ).toThrow(/CHECK/i);

    // The pages read the timeline by task and the archiver by its newest entry, so both indexes
    // have to be there afterwards; the board reads the archive column.
    expect(indexes(db, "task_activity")).toEqual([
      "task_activity_newest",
      "task_activity_task",
    ]);
    expect(indexes(db, "task")).toContain("task_archived");
    expect(
      db
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'task_activity_task'",
        )
        .get()!.sql,
    ).toBe("CREATE INDEX task_activity_task ON task_activity (task_id, kind)");

    // Foreign keys still cascade: a task's timeline goes with it, and a task nothing references
    // can be deleted on its own.
    expect(
      db
        .query<{ on_delete: string }, []>(
          "PRAGMA foreign_key_list(task_activity)",
        )
        .all()
        .map((row) => row.on_delete),
    ).toEqual(["CASCADE"]);
    db.query("DELETE FROM task WHERE id = ?").run(made.parent);
    expect(
      db
        .query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM task_activity WHERE task_id = ?",
        )
        .get(made.parent)!.n,
    ).toBe(0);
    // The subtask and its one entry are untouched, and the edge to the deleted task went with it.
    expect(count(db, "task_activity")).toBe(1);
    expect(count(db, "task")).toBe(2);
    expect(count(db, "task_dependency")).toBe(0);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()!
        .integrity_check,
    ).toBe("ok");
  });

  it("is a no-op on a database that has already run it, which is what rc.3 upgrades with", async () => {
    const db = await oldDatabase();
    seed(db);
    expect(applyMigrations(db, UP_TO_0054)).toEqual([NEWEST]);

    const before = {
      rows: ["task", "task_activity", "task_dependency", "eta_migrations"].map(
        (table) => count(db, table),
      ),
      entries: entries(db),
      kinds: kinds(db),
    };
    expect(applyMigrations(db, UP_TO_0054)).toEqual([]);
    expect(applyMigrations(db, UP_TO_0054)).toEqual([]);
    expect({
      rows: ["task", "task_activity", "task_dependency", "eta_migrations"].map(
        (table) => count(db, table),
      ),
      entries: entries(db),
      kinds: kinds(db),
    }).toEqual(before);
    // One record per migration, never two.
    expect(
      db
        .query<{ id: string; n: number }, []>(
          "SELECT id, count(*) AS n FROM eta_migrations GROUP BY id HAVING n > 1",
        )
        .all(),
    ).toEqual([]);
    expect(count(db, "eta_migrations")).toBe(UP_TO_0054.length);
    db.close();
  });
});
