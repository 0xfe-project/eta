import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Whose a session is, across the upgrade: the keys a v0.3.0 host wrote into `SessionMeta` still
 * name the same owner in this tree, and none of them name two.
 *
 * The keys are the ones that build wrote: `test/upgrade-seed/0.3.0/data/sessions/<session>/meta.json` and
 * the board that goes with it. The shapes a seed has no row of (a routine run, a run made before
 * `session_key` existed, a mentioned agent's session) are pinned byte for byte in
 * session-owner.test.ts.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import { heldIn, ownerOf, taskKey, taskOf } from "../src/session-owner";

const SEED = fileURLToPath(
  new URL("../../../test/upgrade-seed/0.3.0/data", import.meta.url),
);

/** The sessions that host left: its id, the key it is held in, and the title it gave the session. */
function sessions(): { id: string; key: string }[] {
  return readdirSync(join(SEED, "sessions")).map((id) => {
    const meta = JSON.parse(
      readFileSync(join(SEED, "sessions", id, "meta.json"), "utf8"),
    );
    return { id, key: meta.conversationId as string };
  });
}

function board(): Database {
  return new Database(join(SEED, "eta.sqlite"), {
    readonly: true,
    strict: true,
  });
}

const exists = (db: Database, table: string, id: string): boolean =>
  db.query(`SELECT 1 AS one FROM ${table} WHERE id = ?`).get(id) !== null;

describe("the keys a v0.3.0 host left behind", () => {
  it("hold each session in the same owner it did", () => {
    const db = board();
    const left = sessions();
    // One of each: the conversation an agent talked in, and the task its executor worked.
    expect(left.length).toBe(2);
    for (const session of left) {
      const owner = ownerOf(session.key);
      expect(owner).toBeDefined();
      if (owner?.kind === "conversation") {
        expect(exists(db, "conversation", owner.conversationId)).toBe(true);
        expect(heldIn(session.key)).toBe("conversation");
      } else if (owner?.kind === "task") {
        expect(owner.taskId).toBeDefined();
        expect(exists(db, "task", owner.taskId!)).toBe(true);
        expect(heldIn(session.key)).toBe("task");
      } else throw new Error(`no owner for ${session.key}`);
    }
    // Both kinds are there: a board with only one of them proves nothing about the other.
    expect(new Set(left.map((session) => heldIn(session.key)))).toEqual(
      new Set(["conversation", "task"]),
    );
    db.close();
  });

  it("name the task a run of that board belongs to, and only that task", () => {
    const db = board();
    const runs = db
      .query<{ session_key: string; task_id: string }, []>(
        "SELECT session_key, task_id FROM task_run",
      )
      .all();
    expect(runs.length).toBeGreaterThan(0);
    const owners = new Set<string>();
    for (const run of runs) {
      expect(ownerOf(run.session_key)).toEqual({
        kind: "task",
        taskId: run.task_id,
      });
      expect(taskOf(run.session_key)).toBe(run.task_id);
      expect(run.session_key).toBe(taskKey(run.task_id));
      owners.add(run.session_key);
    }
    // One key per task's session, whichever run of it is looked at.
    expect(owners.size).toBe(new Set(runs.map((run) => run.task_id)).size);
    db.close();
  });
});
