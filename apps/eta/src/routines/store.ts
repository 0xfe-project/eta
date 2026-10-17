/**
 * Routines: the rows (REFACTOR.md §9, P3.3).
 *
 * A routine is a name, a model, a schedule and a brief. Everything else is history: each version of
 * the brief, each run with its report and handoff, and the feedback a user left on a run. The
 * history is the point — "why does it do that" is answered by the version that introduced it, and a
 * run's report is what the next run is handed.
 *
 * Two rules live in the schema rather than in code, because they must hold even if two callers race:
 * a routine runs once at a time (a partial unique index), and a brief version is unique per routine.
 */
import type { Database } from "bun:sqlite";
import type { Schedule } from "./schedule";
import { cronOf, nextRun, validateSchedule } from "./schedule";

export type RunStatus = "running" | "sent" | "nothing_new" | "failed";

export interface RoutineRecord {
  id: string;
  name: string;
  /**
   * The group this routine belongs to: where it runs, with whom, and about what. Absent for one
   * made before groups owned routines, and for one made from the all-groups page.
   */
  groupId?: string | undefined;
  model: string;
  schedule: Schedule;
  timezone: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BriefRecord {
  id: string;
  routineId: string;
  version: number;
  text: string;
  /** The feedback this version came from; absent when the user wrote it. */
  feedbackId?: string | undefined;
  createdAt: string;
}

export interface RunRecord {
  id: string;
  routineId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string | undefined;
  report?: string | undefined;
  handoff?: string | undefined;
  error?: string | undefined;
  seenAt?: string | undefined;
}

export interface FeedbackRecord {
  id: string;
  runId: string;
  text: string;
  createdAt: string;
  revisionFailed: boolean;
}

export interface CreateRoutineInput {
  name: string;
  groupId?: string | undefined;
  model: string;
  brief: string;
  schedule: unknown;
  timezone: string;
}

interface RoutineRow {
  id: string;
  name: string;
  group_id: string | null;
  model: string;
  schedule: string;
  timezone: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface BriefRow {
  id: string;
  routine_id: string;
  version: number;
  text: string;
  feedback_id: string | null;
  created_at: string;
}

interface RunRow {
  id: string;
  routine_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  report: string | null;
  handoff: string | null;
  error: string | null;
  seen_at: string | null;
}

interface FeedbackRow {
  id: string;
  run_id: string;
  text: string;
  created_at: string;
  revision_failed: number;
}

const statusOf = (value: string): RunStatus =>
  value === "sent" || value === "nothing_new" || value === "failed"
    ? value
    : "running";

const toRoutine = (row: RoutineRow): RoutineRecord => ({
  id: row.id,
  name: row.name,
  ...(row.group_id === null ? {} : { groupId: row.group_id }),
  model: row.model,
  schedule: validateSchedule(JSON.parse(row.schedule)),
  timezone: row.timezone,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toBrief = (row: BriefRow): BriefRecord => ({
  id: row.id,
  routineId: row.routine_id,
  version: row.version,
  text: row.text,
  ...(row.feedback_id === null ? {} : { feedbackId: row.feedback_id }),
  createdAt: row.created_at,
});

const toRun = (row: RunRow): RunRecord => ({
  id: row.id,
  routineId: row.routine_id,
  status: statusOf(row.status),
  startedAt: row.started_at,
  ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
  ...(row.report === null ? {} : { report: row.report }),
  ...(row.handoff === null ? {} : { handoff: row.handoff }),
  ...(row.error === null ? {} : { error: row.error }),
  ...(row.seen_at === null ? {} : { seenAt: row.seen_at }),
});

const toFeedback = (row: FeedbackRow): FeedbackRecord => ({
  id: row.id,
  runId: row.run_id,
  text: row.text,
  createdAt: row.created_at,
  revisionFailed: row.revision_failed === 1,
});

export class RoutineStore {
  readonly #handle: Database;

  constructor(handle: Database) {
    this.#handle = handle;
  }

  /** Create a routine with its first brief, in one transaction: no routine without a brief. */
  create(input: CreateRoutineInput): RoutineRecord {
    const schedule = validateSchedule(input.schedule);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.#handle.transaction(() => {
      this.#handle
        .query(
          `INSERT INTO routine (id, name, group_id, model, schedule, timezone, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.groupId ?? null,
          input.model,
          JSON.stringify(schedule),
          input.timezone,
          now,
          now,
        );
      this.#handle
        .query(
          `INSERT INTO routine_brief (id, routine_id, version, text, created_at)
           VALUES (?, ?, 1, ?, ?)`,
        )
        .run(crypto.randomUUID(), id, input.brief, now);
    })();
    return this.get(id)!;
  }

  get(id: string): RoutineRecord | undefined {
    const row = this.#handle
      .query("SELECT * FROM routine WHERE id = ?")
      .get(id) as RoutineRow | null;
    return row === null ? undefined : toRoutine(row);
  }

  /** Every routine, most recently changed first. */
  list(): RoutineRecord[] {
    const rows = this.#handle
      .query("SELECT * FROM routine ORDER BY updated_at DESC")
      .all() as RoutineRow[];
    return rows.map(toRoutine);
  }

  /** The enabled ones: what the scheduler puts on its clock. */
  enabled(): RoutineRecord[] {
    const rows = this.#handle
      .query("SELECT * FROM routine WHERE enabled = 1 ORDER BY created_at")
      .all() as RoutineRow[];
    return rows.map(toRoutine);
  }

  /**
   * Change a routine. A new brief is a new version rather than an edit: the old one is what the
   * previous runs were following, and keeping it is what makes a report readable months later.
   */
  update(
    id: string,
    input: {
      name?: string | undefined;
      groupId?: string | undefined;
      model?: string | undefined;
      schedule?: unknown | undefined;
      timezone?: string | undefined;
      enabled?: boolean | undefined;
      brief?: string | undefined;
    },
  ): RoutineRecord | undefined {
    const before = this.get(id);
    if (before === undefined) return undefined;
    const schedule =
      input.schedule === undefined
        ? before.schedule
        : validateSchedule(input.schedule);
    const now = new Date().toISOString();
    this.#handle.transaction(() => {
      this.#handle
        .query(
          `UPDATE routine
              SET name = ?, group_id = ?, model = ?, schedule = ?, timezone = ?, enabled = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          input.name ?? before.name,
          input.groupId ?? before.groupId ?? null,
          input.model ?? before.model,
          JSON.stringify(schedule),
          input.timezone ?? before.timezone,
          (input.enabled ?? before.enabled) ? 1 : 0,
          now,
          id,
        );
      if (input.brief !== undefined && input.brief !== this.brief(id)?.text) {
        this.#writeBrief(id, input.brief, undefined, now);
      }
    })();
    return this.get(id);
  }

  remove(id: string): boolean {
    return (
      this.#handle.query("DELETE FROM routine WHERE id = ?").run(id).changes > 0
    );
  }

  /** The brief in force: the newest version. */
  brief(routineId: string): BriefRecord | undefined {
    const row = this.#handle
      .query(
        "SELECT * FROM routine_brief WHERE routine_id = ? ORDER BY version DESC LIMIT 1",
      )
      .get(routineId) as BriefRow | null;
    return row === null ? undefined : toBrief(row);
  }

  /** Every version of a brief, newest first: what a routine's page lists. */
  briefs(routineId: string): BriefRecord[] {
    const rows = this.#handle
      .query(
        "SELECT * FROM routine_brief WHERE routine_id = ? ORDER BY version DESC",
      )
      .all(routineId) as BriefRow[];
    return rows.map(toBrief);
  }

  /**
   * Revise a brief from feedback: a new version, pointing at what asked for it.
   *
   * `basedOn` is the version the revision read. If the brief has moved on since (the user edited
   * it, or another revision landed), this refuses rather than overwriting — the caller retries
   * from the newer text.
   */
  revise(input: {
    routineId: string;
    text: string;
    feedbackId?: string | undefined;
    basedOn?: number | undefined;
  }): BriefRecord | undefined {
    const current = this.brief(input.routineId);
    if (current === undefined) return undefined;
    if (input.basedOn !== undefined && current.version !== input.basedOn)
      return undefined;
    return this.#writeBrief(
      input.routineId,
      input.text,
      input.feedbackId,
      new Date().toISOString(),
    );
  }

  /** Restore an old version: it becomes the newest, so the history still tells the story. */
  restore(routineId: string, version: number): BriefRecord | undefined {
    const row = this.#handle
      .query("SELECT * FROM routine_brief WHERE routine_id = ? AND version = ?")
      .get(routineId, version) as BriefRow | null;
    if (row === null) return undefined;
    return this.#writeBrief(
      routineId,
      row.text,
      undefined,
      new Date().toISOString(),
    );
  }

  /**
   * Start a run, unless one is already going.
   *
   * The partial unique index is the arbiter: two triggers arriving together cannot both start a
   * run, and the second is told so rather than failing with a constraint error.
   */
  startRun(routineId: string, at: Date = new Date()): RunRecord | undefined {
    if (this.runningRun(routineId) !== undefined) return undefined;
    const id = crypto.randomUUID();
    try {
      this.#handle
        .query(
          `INSERT INTO routine_run (id, routine_id, status, started_at)
           VALUES (?, ?, 'running', ?)`,
        )
        .run(id, routineId, at.toISOString());
    } catch {
      return undefined;
    }
    return this.run(id);
  }

  runningRun(routineId: string): RunRecord | undefined {
    const row = this.#handle
      .query(
        "SELECT * FROM routine_run WHERE routine_id = ? AND status = 'running' LIMIT 1",
      )
      .get(routineId) as RunRow | null;
    return row === null ? undefined : toRun(row);
  }

  /** Finish a run: what it reports, what it hands over, or why it failed. */
  finishRun(
    runId: string,
    input: {
      status: Exclude<RunStatus, "running">;
      report?: string | undefined;
      handoff?: string | undefined;
      error?: string | undefined;
    },
    at: Date = new Date(),
  ): RunRecord | undefined {
    const changed = this.#handle
      .query(
        `UPDATE routine_run
            SET status = ?, finished_at = ?, report = ?, handoff = ?, error = ?
          WHERE id = ? AND status = 'running'`,
      )
      .run(
        input.status,
        at.toISOString(),
        input.report ?? null,
        input.handoff ?? null,
        input.error ?? null,
        runId,
      );
    return changed.changes === 0 ? undefined : this.run(runId);
  }

  run(id: string): RunRecord | undefined {
    const row = this.#handle
      .query("SELECT * FROM routine_run WHERE id = ?")
      .get(id) as RunRow | null;
    return row === null ? undefined : toRun(row);
  }

  /** A routine's runs, newest first; `limit` is what a summary shows. */
  runs(routineId: string, limit = 50): RunRecord[] {
    const rows = this.#handle
      .query(
        "SELECT * FROM routine_run WHERE routine_id = ? ORDER BY started_at DESC LIMIT ?",
      )
      .all(routineId, limit) as RunRow[];
    return rows.map(toRun);
  }

  /** The handoff the next run reads: the newest one anybody wrote. */
  handoff(routineId: string): { text: string; writtenAt: string } | undefined {
    const row = this.#handle
      .query(
        `SELECT handoff, finished_at FROM routine_run
          WHERE routine_id = ? AND handoff IS NOT NULL AND handoff <> ''
          ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
      )
      .get(routineId) as { handoff: string; finished_at: string | null } | null;
    return row === null || row.finished_at === null
      ? undefined
      : { text: row.handoff, writtenAt: row.finished_at };
  }

  /** Mark every finished run seen: what a routine's page does when it is opened. */
  markSeen(routineId: string, at: Date = new Date()): number {
    return this.#handle
      .query(
        `UPDATE routine_run SET seen_at = ?
          WHERE routine_id = ? AND finished_at IS NOT NULL AND seen_at IS NULL`,
      )
      .run(at.toISOString(), routineId).changes;
  }

  /** Reports and failures the user has not looked at: what a routine's badge counts. */
  unseen(routineId: string): { reports: number; failures: number } {
    const rows = this.#handle
      .query(
        `SELECT status, COUNT(*) AS n FROM routine_run
          WHERE routine_id = ? AND finished_at IS NOT NULL AND seen_at IS NULL
          GROUP BY status`,
      )
      .all(routineId) as { status: string; n: number }[];
    const of = (status: string): number =>
      rows.find((row) => row.status === status)?.n ?? 0;
    return { reports: of("sent"), failures: of("failed") };
  }

  /** Leave feedback on a run. The revision happens later, in the background. */
  feedback(
    runId: string,
    text: string,
    at: Date = new Date(),
  ): FeedbackRecord | undefined {
    if (this.run(runId) === undefined) return undefined;
    const id = crypto.randomUUID();
    this.#handle
      .query(
        "INSERT INTO routine_feedback (id, run_id, text, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(id, runId, text, at.toISOString());
    return this.feedbackOf(id);
  }

  feedbackOf(id: string): FeedbackRecord | undefined {
    const row = this.#handle
      .query("SELECT * FROM routine_feedback WHERE id = ?")
      .get(id) as FeedbackRow | null;
    return row === null ? undefined : toFeedback(row);
  }

  feedbacks(runId: string): FeedbackRecord[] {
    const rows = this.#handle
      .query(
        "SELECT * FROM routine_feedback WHERE run_id = ? ORDER BY created_at",
      )
      .all(runId) as FeedbackRow[];
    return rows.map(toFeedback);
  }

  /** Feedback nobody has revised yet: what the background pass picks up. */
  pendingFeedback(routineId: string): FeedbackRecord[] {
    const rows = this.#handle
      .query(
        `SELECT f.* FROM routine_feedback f
           JOIN routine_run r ON r.id = f.run_id
          WHERE r.routine_id = ? AND f.revision_failed = 0
            AND NOT EXISTS (SELECT 1 FROM routine_brief b WHERE b.feedback_id = f.id)
          ORDER BY f.created_at`,
      )
      .all(routineId) as FeedbackRow[];
    return rows.map(toFeedback);
  }

  /** A revision that could not be made: recorded so the page can say so and stop retrying. */
  failRevision(feedbackId: string): boolean {
    return (
      this.#handle
        .query("UPDATE routine_feedback SET revision_failed = 1 WHERE id = ?")
        .run(feedbackId).changes > 0
    );
  }

  /** When a routine runs next, from its own schedule and zone. */
  nextRunAt(routine: RoutineRecord, from: Date = new Date()): Date | undefined {
    return routine.enabled
      ? nextRun(routine.schedule, routine.timezone, from)
      : undefined;
  }

  /** The cron the page counts down with; the same expression the scheduler fires on. */
  cron(routine: RoutineRecord): string {
    return cronOf(routine.schedule);
  }

  /**
   * Runs that were `running` when the process died: they are failures now.
   *
   * A run cannot be resumed (its session is gone), and a row that says `running` forever would
   * keep the routine from ever starting again — the unique index would refuse every trigger.
   */
  recover(at: Date = new Date()): RunRecord[] {
    const rows = this.#handle
      .query("SELECT * FROM routine_run WHERE status = 'running'")
      .all() as RunRow[];
    const recovered: RunRecord[] = [];
    for (const row of rows) {
      const finished = this.finishRun(
        row.id,
        { status: "failed", error: "运行被中断（服务重启）。" },
        at,
      );
      if (finished !== undefined) recovered.push(finished);
    }
    return recovered;
  }

  #writeBrief(
    routineId: string,
    text: string,
    feedbackId: string | undefined,
    now: string,
  ): BriefRecord | undefined {
    const current = this.brief(routineId);
    const version = (current?.version ?? 0) + 1;
    const id = crypto.randomUUID();
    this.#handle
      .query(
        `INSERT INTO routine_brief (id, routine_id, version, text, feedback_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, routineId, version, text, feedbackId ?? null, now);
    this.#handle
      .query("UPDATE routine SET updated_at = ? WHERE id = ?")
      .run(now, routineId);
    const row = this.#handle
      .query("SELECT * FROM routine_brief WHERE id = ?")
      .get(id) as BriefRow | null;
    return row === null ? undefined : toBrief(row);
  }
}
