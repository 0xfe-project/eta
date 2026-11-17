import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Whose a session is, across the upgrade: the keys a v0.3.0 host wrote into `SessionMeta` still
 * name the same owner in this tree, and none of them name two.
 *
 * The keys are the ones that build wrote: `test/upgrade-seed/0.3.0/data/sessions/<session>/meta.json` and
 * the board that goes with it. Two shapes have no row in a seed — a routine run and a run made
 * before `session_key` existed — so they are taken from that build's own source
 * (`apps/eta/src/routines/session-key.ts`, `0036-run-continuation.sql`) and from the run row the
 * seed does have, cleared the way an old row is.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import {
  heldIn,
  mentionKey,
  ownerOf,
  routineKey,
  sessionKeyOf,
  taskKey,
  taskOf,
} from "../src/session-owner";

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

  it("read a run made before the key named the task through the run", () => {
    // 0036 added `session_key`; a run from before it recorded none, and its session was held in
    // `task-run:<its id>`. The real 0.3.0 board this was checked against has exactly one such run.
    const db = board();
    const run = db
      .query<{ id: string; task_id: string }, []>(
        "SELECT id, task_id FROM task_run LIMIT 1",
      )
      .get()!;
    db.close();
    const key = sessionKeyOf({ id: run.id, sessionKey: null });
    expect(key).toBe(`task-run:${run.id}`);
    // Without the run, the task is unknown — the kind is still a task's, never a conversation's.
    expect(ownerOf(key)).toEqual({ kind: "task", taskId: undefined });
    expect(heldIn(key)).toBe("task");
    const taskOfRun = (id: string) => (id === run.id ? run.task_id : undefined);
    expect(ownerOf(key, taskOfRun)).toEqual({
      kind: "task",
      taskId: run.task_id,
    });
    expect(taskOf(key, taskOfRun)).toBe(run.task_id);
  });

  it("keep a mentioned agent's session the task's, which is how an old mail names it", () => {
    // A session's id is `<key>:<agentId>` (conversations/engine.ts), and a mail records the
    // conversation it came from — for a task's session that is this, with the agent still on it.
    const db = board();
    const task = db
      .query<{ id: string }, []>("SELECT id FROM task LIMIT 1")
      .get()!;
    db.close();
    const key = mentionKey(task.id, "agent-ada");
    expect(key).toBe(`task:${task.id}:agent-ada`);
    expect(taskOf(key)).toBe(task.id);
    expect(ownerOf(key)).toEqual({ kind: "task", taskId: task.id });
    // A conversation's session id is not a task's: no mail from it may claim one.
    const plain = `4fec816e-db4a-4977-9498-96edb2a8de45:agent-ada`;
    expect(taskOf(plain)).toBeUndefined();
    expect(ownerOf(plain)).toEqual({
      kind: "conversation",
      conversationId: "4fec816e-db4a-4977-9498-96edb2a8de45:agent-ada",
    });
  });

  it("keep a routine run's session the routine's, in the key 0.3.0 made", () => {
    // 0.3.0's routines/session-key.ts: `routine:` + the run's id, the same string this tree makes.
    const runId = "6f5e5d5e-93ad-4c13-9d0f-1f0f0d3f7a11";
    expect(routineKey(runId)).toBe(`routine:${runId}`);
    expect(ownerOf(`routine:${runId}`)).toEqual({ kind: "routine", runId });
    expect(heldIn(`routine:${runId}`)).toBe("routine");
    expect(taskOf(`routine:${runId}`)).toBeUndefined();
    // A routine run id that happens to hold a task's key is still the routine's: the prefix at the
    // start decides, and nothing else.
    expect(ownerOf(`routine:task:${runId}`)).toEqual({
      kind: "routine",
      runId: `task:${runId}`,
    });
  });
});
