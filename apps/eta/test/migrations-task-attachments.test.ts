/**
 * 0064, as an upgrade: the `attachment` table is made again so a file can be a task's as well as a
 * conversation's. Every row an older host kept comes through as it was, still the conversation's,
 * and the cascade that takes a conversation's files with it still holds; a task's file is new, and
 * a row that is both or neither is refused.
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

const NEWEST = "0064-task-attachments";
const ALL = loadMigrations().filter((migration) => migration.id <= NEWEST);
const BEFORE = ALL.filter((migration) => migration.id < NEWEST);

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

async function oldDatabase(): Promise<Database> {
  const db = openDatabase(databasePath(join(await tempDir(), "eta.sqlite")));
  open.push(db);
  applyMigrations(db, BEFORE);
  const now = Date.now();
  db.query(
    "INSERT INTO machine (id, kind, name, created_at) VALUES ('m', 'primary', 'here', ?)",
  ).run(now);
  db.query(
    "INSERT INTO project (id, machine_id, path, name, created_at, updated_at) VALUES ('p', 'm', '/p', 'p', ?, ?)",
  ).run(now, now);
  const conversation = db.query(
    "INSERT INTO conversation (id, project_id, kind, name, created_at, updated_at) VALUES (?, 'p', 'group', ?, ?, ?)",
  );
  conversation.run("c-1", "one", now, now);
  conversation.run("c-2", "two", now, now);
  const file = db.query(
    "INSERT INTO attachment (id, conversation_id, name, content_type, size, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  file.run("a-1", "c-1", "shot.png", "image/png", 10, "msg-1", now);
  file.run("a-2", "c-1", "notes.txt", "text/plain", 3, null, now + 1);
  file.run("a-3", "c-2", "x.bmp", "image/bmp", 7, "msg-2", now + 2);
  db.query(
    "INSERT INTO task (id, title, status, created_at, updated_at) VALUES ('t-1', 'A task', 'todo', ?, ?)",
  ).run(now, now);
  return db;
}

const rows = (db: Database) =>
  db
    .query<Record<string, unknown>, []>(
      "SELECT id, conversation_id, name, content_type, size, message_id, created_at FROM attachment ORDER BY id",
    )
    .all();

describe("0064-task-attachments", () => {
  it("keeps every file a conversation had, as it was", async () => {
    const db = await oldDatabase();
    const before = rows(db);
    expect(applyMigrations(db, ALL)).toEqual([NEWEST]);
    expect(rows(db)).toEqual(before);
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM attachment WHERE task_id IS NOT NULL",
        )
        .get()!.n,
    ).toBe(0);
    // The pages' lookups still have their indexes.
    const indexes = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'attachment' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((index) => index.name);
    expect(indexes).toEqual([
      "attachment_conversation",
      "attachment_task",
      "attachment_unsent",
    ]);
  });

  it("takes a task's file, refuses one that is both or neither, and cascades from either owner", async () => {
    const db = await oldDatabase();
    applyMigrations(db, ALL);
    const insert = db.query(
      "INSERT INTO attachment (id, conversation_id, task_id, name, content_type, size, created_at) VALUES (?, ?, ?, 'f', 'image/png', 1, 0)",
    );
    insert.run("a-task", null, "t-1");
    expect(() => insert.run("a-both", "c-1", "t-1")).toThrow(/CHECK/);
    expect(() => insert.run("a-none", null, null)).toThrow(/CHECK/);
    expect(() => insert.run("a-lost", null, "t-gone")).toThrow(/FOREIGN KEY/);
    db.query("DELETE FROM task WHERE id = 't-1'").run();
    db.query("DELETE FROM conversation WHERE id = 'c-1'").run();
    expect(rows(db).map((row) => row.id)).toEqual(["a-3"]);
  });
});
