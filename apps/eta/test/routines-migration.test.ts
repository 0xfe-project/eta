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

describe("0067-routine-triggers", () => {
  it("allows nullable routine.schedule, started_by='trigger', and cascades trigger/event tables", () => {
    const db = openDatabase(":memory:");
    applyMigrations(db, upTo("0067-routine-triggers"));

    // Existing scheduled routine and its run/brief/feedback survive rebuild intact.
    db.exec(
      "INSERT INTO routine (id, name, schedule, timezone, enabled, created_at, updated_at) VALUES ('r1', 'Digest', '{\"kind\":\"daily\",\"time\":\"09:00\"}', 'UTC', 1, 1, 2)",
    );
    db.exec(
      "INSERT INTO routine_run (id, routine_id, started_by, status, started_at, finished_at, title, report, handoff) VALUES ('run1', 'r1', 'schedule', 'sent', 3, 4, 'T', '# T', 'note')",
    );
    db.exec(
      "INSERT INTO routine_feedback (id, run_id, text, created_at) VALUES ('f1', 'run1', 'ok', 5)",
    );
    db.exec(
      "INSERT INTO routine_brief (routine_id, version, text, feedback_id, created_at) VALUES ('r1', 1, 'Do it.', NULL, 1)",
    );

    applyMigrations(db, all);

    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("SELECT id, name, schedule FROM routine").all()).toEqual([
      {
        id: "r1",
        name: "Digest",
        schedule: '{"kind":"daily","time":"09:00"}',
      },
    ]);
    expect(
      db.query("SELECT id, started_by, status FROM routine_run").all(),
    ).toEqual([{ id: "run1", started_by: "schedule", status: "sent" }]);

    // Trigger-only routine (schedule = NULL) + trigger binding + started_by = 'trigger'.
    db.exec(
      "INSERT INTO routine (id, name, schedule, timezone, enabled, created_at, updated_at) VALUES ('r2', 'Watcher', NULL, 'UTC', 1, 10, 10)",
    );
    db.exec(
      "INSERT INTO routine_brief (routine_id, version, text, feedback_id, created_at) VALUES ('r2', 1, 'Watch.', NULL, 10)",
    );
    db.exec(
      "INSERT INTO routine_trigger (routine_id, provider, source, trigger_slug, account_id, config_json, instance_id, status, created_at, updated_at) VALUES ('r2', 'composio', 'github', 'GITHUB_COMMIT_EVENT', 'ca_1', '{}', 'ti_1', 'active', 10, 10)",
    );
    db.exec(
      "INSERT INTO routine_run (id, routine_id, started_by, status, started_at) VALUES ('run2', 'r2', 'trigger', 'running', 11)",
    );

    // One-at-a-time constraint still holds across started_by = 'trigger'.
    expect(() =>
      db.exec(
        "INSERT INTO routine_run (id, routine_id, started_by, status, started_at) VALUES ('run3', 'r2', 'trigger', 'running', 12)",
      ),
    ).toThrow();

    // Idempotency key UNIQUE(routine_id, event_id) rejects duplicate event for same routine,
    // while allowing the same event_id on another routine.
    db.exec(
      "INSERT INTO routine_trigger_event (id, routine_id, provider, event_id, trigger_slug, occurred_at, received_at, payload_json, state) VALUES ('e1', 'r2', 'composio', 'msg_1', 'GITHUB_COMMIT_EVENT', 11, 11, '{}', 'pending')",
    );
    expect(() =>
      db.exec(
        "INSERT INTO routine_trigger_event (id, routine_id, provider, event_id, trigger_slug, occurred_at, received_at, payload_json, state) VALUES ('e2', 'r2', 'composio', 'msg_1', 'GITHUB_COMMIT_EVENT', 12, 12, '{}', 'pending')",
      ),
    ).toThrow(/UNIQUE/);
    db.exec(
      "INSERT INTO routine_trigger_event (id, routine_id, provider, event_id, trigger_slug, occurred_at, received_at, payload_json, state) VALUES ('e3', 'r1', 'composio', 'msg_1', 'GITHUB_COMMIT_EVENT', 12, 12, '{}', 'pending')",
    );

    // Deleting r2 cascades trigger binding, runs, briefs, and queued events without disturbing r1.
    db.exec("DELETE FROM routine WHERE id = 'r2'");
    expect(
      db
        .query(
          "SELECT COUNT(*) AS n FROM routine_trigger WHERE routine_id = 'r2'",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(
      db
        .query(
          "SELECT COUNT(*) AS n FROM routine_trigger_event WHERE routine_id = 'r2'",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(
      db
        .query(
          "SELECT COUNT(*) AS n FROM routine_trigger_event WHERE routine_id = 'r1'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });
});
