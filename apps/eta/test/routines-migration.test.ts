/**
 * 0053: routines are Captain's. The model and the report conversation go, a run can be `skipped`,
 * and whatever a database already held (routines, briefs, runs, feedback) comes through the
 * rebuild with its links intact.
 */
import { describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";

const all = loadMigrations();
const upTo = (id: string) =>
  all.slice(
    0,
    all.findIndex((m) => m.id === id),
  );

describe("0053-routines-run-by-captain", () => {
  it("drops model and conversation_id, keeps every row and link, and allows skipped", () => {
    const db = openDatabase(":memory:");
    applyMigrations(db, upTo("0053-routines-run-by-captain"));
    db.exec(
      "INSERT INTO routine (id, name, model, schedule, timezone, enabled, created_at, updated_at) VALUES ('r1', 'Digest', 'p:m', '{\"kind\":\"daily\",\"time\":\"09:00\"}', 'UTC', 1, 1, 2)",
    );
    db.exec(
      "INSERT INTO routine_run (id, routine_id, started_by, status, started_at, finished_at, title, report, handoff) VALUES ('run1', 'r1', 'schedule', 'sent', 3, 4, 'T', '# T', 'note to self')",
    );
    db.exec(
      "INSERT INTO routine_feedback (id, run_id, text, created_at) VALUES ('f1', 'run1', 'shorter', 5)",
    );
    db.exec(
      "INSERT INTO routine_brief (routine_id, version, text, feedback_id, created_at) VALUES ('r1', 1, 'Do it.', NULL, 1), ('r1', 2, 'Do it shorter.', 'f1', 6)",
    );

    applyMigrations(db, all);

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(routine)")
      .all()
      .map((c) => c.name);
    expect(columns).not.toContain("model");
    expect(columns).not.toContain("conversation_id");
    expect(db.query("SELECT id, name, enabled FROM routine").all()).toEqual([
      { id: "r1", name: "Digest", enabled: 1 },
    ]);
    expect(
      db.query("SELECT id, status, handoff FROM routine_run").all(),
    ).toEqual([{ id: "run1", status: "sent", handoff: "note to self" }]);
    expect(
      db
        .query(
          "SELECT version, feedback_id FROM routine_brief ORDER BY version",
        )
        .all(),
    ).toEqual([
      { version: 1, feedback_id: null },
      { version: 2, feedback_id: "f1" },
    ]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

    // A skipped run is a row like any other; the one-running index still holds.
    db.exec(
      "INSERT INTO routine_run (id, routine_id, started_by, status, started_at, finished_at, error) VALUES ('run2', 'r1', 'schedule', 'skipped', 7, 7, 'Captain is off')",
    );
    db.exec(
      "INSERT INTO routine_run (id, routine_id, started_by, status, started_at) VALUES ('run3', 'r1', 'user', 'running', 8)",
    );
    expect(() =>
      db.exec(
        "INSERT INTO routine_run (id, routine_id, started_by, status, started_at) VALUES ('run4', 'r1', 'user', 'running', 9)",
      ),
    ).toThrow();
    expect(() =>
      db.exec(
        "INSERT INTO routine_run (id, routine_id, started_by, status, started_at) VALUES ('run5', 'r1', 'user', 'bogus', 9)",
      ),
    ).toThrow();

    // The references point at the new tables: deleting the routine takes everything with it.
    db.exec("DELETE FROM routine WHERE id = 'r1'");
    for (const table of ["routine_run", "routine_feedback", "routine_brief"])
      expect(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({
        n: 0,
      });
  });
});
