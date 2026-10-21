import type {
  TaskQueueReason,
  TaskRunStatus,
  TaskRunView,
} from "@eta/client-contracts";
/**
 * The runs of tasks: the rows, and nothing that decides.
 *
 * A run is one attempt of a task's executor, and the table is also the queue: a `queued` row waits
 * until the runner starts it. The runner (`runner.ts`) decides when; this file only keeps what it
 * is told and answers the questions it asks (how many are going on a machine, is the task busy).
 * Statuses only ever move forward (queued, starting, running, then one of the three ends), and a
 * run that ended never changes again, so a late write from a run that was already stopped is
 * dropped rather than undone.
 */
import type { Database } from "bun:sqlite";

export interface RunRecord extends TaskRunView {
  taskId: string;
  /** What the session is held in (`session-key.ts`); null until the run has a session. */
  sessionKey: string | null;
}

interface Row {
  id: string;
  task_id: string;
  machine_id: string | null;
  status: string;
  queue_reason: string | null;
  session_id: string | null;
  continues_run_id: string | null;
  session_key: string | null;
  workspace: string | null;
  nudged: number;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

const recordOf = (row: Row): RunRecord => ({
  id: row.id,
  taskId: row.task_id,
  status: row.status as TaskRunStatus,
  queueReason: row.queue_reason as TaskQueueReason | null,
  machineId: row.machine_id,
  sessionId: row.session_id,
  continuesRunId: row.continues_run_id,
  sessionKey: row.session_key,
  workspace: row.workspace,
  nudged: row.nudged === 1,
  error: row.error,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

/** The statuses of a run that has not ended. */
const OPEN_RUN_STATUSES = ["queued", "starting", "running"] as const;

export class TaskRunStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * A run, queued, on the machine the task's project is on. A run that continues another one works
   * in the session the other one made, and says so with `continuesRunId` (`tasks.rerun` leaves it
   * null: a rerun starts afresh and remembers nothing).
   */
  create(
    taskId: string,
    machineId: string | null,
    continuesRunId: string | null = null,
  ): RunRecord {
    const id = crypto.randomUUID();
    this.#db
      .query(
        `INSERT INTO task_run (id, task_id, machine_id, continues_run_id, created_at)
          VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, taskId, machineId, continuesRunId, Date.now());
    return this.get(id)!;
  }

  get(id: string): RunRecord | undefined {
    const row = this.#db
      .query<Row, [string]>("SELECT * FROM task_run WHERE id = ?")
      .get(id);
    return row === null ? undefined : recordOf(row);
  }

  /** A task's runs, oldest first. */
  ofTask(taskId: string): RunRecord[] {
    return this.#db
      .query<Row, [string]>(
        "SELECT * FROM task_run WHERE task_id = ? ORDER BY created_at, rowid",
      )
      .all(taskId)
      .map(recordOf);
  }

  /**
   * The run that works in this session, if one does. Several runs hold one session, since a
   * continuation works in the session of the run before it: the one going now answers, and after
   * it the last one that did.
   */
  bySession(sessionId: string): RunRecord | undefined {
    const row = this.#db
      .query<Row, [string]>(
        `SELECT * FROM task_run WHERE session_id = ?
          ORDER BY status IN ('queued', 'starting', 'running') DESC, created_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get(sessionId);
    return row === null ? undefined : recordOf(row);
  }

  /** The run whose session a continuation carries on: this task's newest session, if it has one. */
  lastSessionOf(taskId: string): RunRecord | undefined {
    const row = this.#db
      .query<Row, [string]>(
        `SELECT * FROM task_run
          WHERE task_id = ? AND session_id IS NOT NULL
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(taskId);
    return row === null ? undefined : recordOf(row);
  }

  /** The sessions that run on a machine, by the runs that hold them. */
  sessionsOn(machineId: string): string[] {
    return this.#db
      .query<{ session_id: string }, [string]>(
        `SELECT DISTINCT session_id FROM task_run
          WHERE machine_id = ? AND session_id IS NOT NULL`,
      )
      .all(machineId)
      .map((row) => row.session_id);
  }

  /** Runs waiting for their turn, in the order they were asked for. */
  queued(): RunRecord[] {
    return this.#db
      .query<Row, []>(
        "SELECT * FROM task_run WHERE status = 'queued' ORDER BY created_at, rowid",
      )
      .all()
      .map(recordOf);
  }

  /** The task's runs that have not ended. */
  openOf(taskId: string): RunRecord[] {
    return this.ofTask(taskId).filter((run) =>
      (OPEN_RUN_STATUSES as readonly string[]).includes(run.status),
    );
  }

  /** How many runs are starting or going on a machine: the slots it has used. */
  activeOn(machineId: string): number {
    return this.#db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM task_run
          WHERE machine_id = ? AND status IN ('starting', 'running')`,
      )
      .get(machineId)!.n;
  }

  /** Whether the task has a run starting or going, other than this one. */
  busy(taskId: string, except: string): boolean {
    return (
      this.#db
        .query<{ n: number }, [string, string]>(
          `SELECT COUNT(*) AS n FROM task_run
            WHERE task_id = ? AND id <> ? AND status IN ('starting', 'running')`,
        )
        .get(taskId, except)!.n > 0
    );
  }

  /** Why a queued run waits, or null when it does not (or no longer). Returns whether it changed. */
  setQueueReason(id: string, reason: TaskQueueReason | null): boolean {
    return (
      this.#db
        .query(
          `UPDATE task_run SET queue_reason = ?
            WHERE id = ? AND status = 'queued' AND queue_reason IS NOT ?`,
        )
        .run(reason, id, reason).changes > 0
    );
  }

  /** queued -> starting. False when the run was stopped while it waited. */
  start(id: string): boolean {
    return (
      this.#db
        .query(
          `UPDATE task_run SET status = 'starting', queue_reason = NULL, started_at = ?
            WHERE id = ? AND status = 'queued'`,
        )
        .run(Date.now(), id).changes > 0
    );
  }

  /**
   * The session the run works in, what it is held in, and the directory it works in. A
   * continuation writes the session and the key it inherited, not ones it made.
   */
  setSession(
    id: string,
    sessionId: string,
    workspace: string,
    sessionKey: string,
  ): void {
    this.#db
      .query(
        "UPDATE task_run SET session_id = ?, workspace = ?, session_key = ? WHERE id = ?",
      )
      .run(sessionId, workspace, sessionKey, id);
  }

  /** starting -> running. */
  running(id: string): boolean {
    return (
      this.#db
        .query(
          "UPDATE task_run SET status = 'running' WHERE id = ? AND status = 'starting'",
        )
        .run(id).changes > 0
    );
  }

  nudged(id: string): void {
    this.#db.query("UPDATE task_run SET nudged = 1 WHERE id = ?").run(id);
  }

  /** The run ends. Only a run that has not ended can: the second write of a race is dropped. */
  finish(
    id: string,
    status: "completed" | "failed" | "interrupted",
    error: string | null = null,
  ): RunRecord | undefined {
    const changed = this.#db
      .query(
        `UPDATE task_run SET status = ?, error = ?, queue_reason = NULL, finished_at = ?
          WHERE id = ? AND status IN ('queued', 'starting', 'running')`,
      )
      .run(status, error, Date.now(), id).changes;
    return changed === 0 ? undefined : this.get(id);
  }

  /** What a restart left going cannot be: those runs ended with it. Returns them as they now read. */
  recover(error: string): RunRecord[] {
    const going = this.#db
      .query<Row, []>(
        "SELECT * FROM task_run WHERE status IN ('starting', 'running')",
      )
      .all();
    return going.flatMap((row) => this.finish(row.id, "failed", error) ?? []);
  }
}
