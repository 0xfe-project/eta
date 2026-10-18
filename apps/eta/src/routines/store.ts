/**
 * The routines' rows: the routine, the versions of its brief, its runs and the feedback on them.
 *
 * Two rules live in the schema because they must hold even when two callers race: a routine runs
 * once at a time (a partial unique index on the one running row) and a piece of feedback leads to
 * at most one brief version. The rest of what this file does is statements; when a thing happens
 * is the runner's and the clock's business, never this file's.
 */
import type {
  RoutineSchedule,
  RunStatus,
  RunTrigger,
} from "@eta/client-contracts";
import type { Database } from "bun:sqlite";

export interface RoutineRecord {
  id: string;
  name: string;
  conversationId: string | null;
  model: string | null;
  schedule: RoutineSchedule;
  timezone: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface BriefRecord {
  routineId: string;
  version: number;
  text: string;
  feedbackId: string | null;
  createdAt: number;
}

export interface RunRecord {
  id: string;
  routineId: string;
  startedBy: RunTrigger;
  status: RunStatus;
  sessionId: string | null;
  startedAt: number;
  finishedAt: number | null;
  title: string | null;
  report: string | null;
  handoff: string | null;
  error: string | null;
  seenAt: number | null;
}

export interface FeedbackRecord {
  id: string;
  routineId: string;
  runId: string;
  text: string;
  createdAt: number;
  revisionFailed: boolean;
  /** The version of the brief it led to. */
  briefVersion: number | null;
}

/** What a run ends with. A report makes it `sent`; none makes it `no_news` unless it failed. */
export type RunOutcome =
  | { status: "sent"; report: string; title?: string; handoff?: string }
  | { status: "no_news"; handoff?: string }
  | { status: "failed"; error: string };

interface RoutineRow {
  id: string;
  name: string;
  conversation_id: string | null;
  model: string | null;
  schedule: string;
  timezone: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface BriefRow {
  routine_id: string;
  version: number;
  text: string;
  feedback_id: string | null;
  created_at: number;
}

interface RunRow {
  id: string;
  routine_id: string;
  started_by: string;
  status: string;
  session_id: string | null;
  started_at: number;
  finished_at: number | null;
  title: string | null;
  report: string | null;
  handoff: string | null;
  error: string | null;
  seen_at: number | null;
}

interface FeedbackRow {
  id: string;
  routine_id: string;
  run_id: string;
  text: string;
  created_at: number;
  revision_failed: number;
  brief_version: number | null;
}

const routineOf = (row: RoutineRow): RoutineRecord => ({
  id: row.id,
  name: row.name,
  conversationId: row.conversation_id,
  model: row.model,
  // Written only through `parseSchedule`, so it reads back as what it was.
  schedule: JSON.parse(row.schedule) as RoutineSchedule,
  timezone: row.timezone,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const briefOf = (row: BriefRow): BriefRecord => ({
  routineId: row.routine_id,
  version: row.version,
  text: row.text,
  feedbackId: row.feedback_id,
  createdAt: row.created_at,
});

const runOf = (row: RunRow): RunRecord => ({
  id: row.id,
  routineId: row.routine_id,
  startedBy: row.started_by as RunTrigger,
  status: row.status as RunStatus,
  sessionId: row.session_id,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  title: row.title,
  report: row.report,
  handoff: row.handoff,
  error: row.error,
  seenAt: row.seen_at,
});

const feedbackOf = (row: FeedbackRow): FeedbackRecord => ({
  id: row.id,
  routineId: row.routine_id,
  runId: row.run_id,
  text: row.text,
  createdAt: row.created_at,
  revisionFailed: row.revision_failed === 1,
  briefVersion: row.brief_version,
});

/** A report's first heading, or failing that its first line: what a list shows of it. */
export function titleOf(report: string): string | null {
  for (const line of report.split(/\r?\n/)) {
    const title = line.replace(/^\s*#+\s*/, "").trim();
    if (title !== "") return title.slice(0, 200);
  }
  return null;
}

/** Text that is only whitespace is no text. */
const present = (text: string | undefined): string | null => {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

/** `LIKE` matches this literally, `%` and `_` included. */
const likeOf = (text: string): string =>
  `%${text.replaceAll(/[\\%_]/g, (c) => `\\${c}`)}%`;

const FEEDBACK = `SELECT f.*, r.routine_id AS routine_id, b.version AS brief_version
                    FROM routine_feedback f
                    JOIN routine_run r ON r.id = f.run_id
                    LEFT JOIN routine_brief b ON b.feedback_id = f.id`;

export class RoutineStore {
  readonly #db: Database;
  readonly #now: () => number;

  constructor(db: Database, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /* ---------------------------------------------------------------- routines */

  /** Every routine, in the order they were made. */
  list(): RoutineRecord[] {
    return this.#db
      .query<RoutineRow, []>("SELECT * FROM routine ORDER BY created_at, id")
      .all()
      .map(routineOf);
  }

  /** The ones on the clock. */
  enabled(): RoutineRecord[] {
    return this.list().filter((routine) => routine.enabled);
  }

  get(id: string): RoutineRecord | undefined {
    const row = this.#db
      .query<RoutineRow, [string]>("SELECT * FROM routine WHERE id = ?")
      .get(id);
    return row === null ? undefined : routineOf(row);
  }

  /** A routine and its first brief appear together or not at all. */
  create(input: {
    name: string;
    brief: string;
    conversationId: string | null;
    model: string | null;
    schedule: RoutineSchedule;
    timezone: string;
    enabled: boolean;
  }): RoutineRecord {
    const id = crypto.randomUUID();
    const now = this.#now();
    this.#db.transaction(() => {
      this.#db
        .query(
          `INSERT INTO routine (id, name, conversation_id, model, schedule, timezone, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.conversationId,
          input.model,
          JSON.stringify(input.schedule),
          input.timezone,
          input.enabled ? 1 : 0,
          now,
          now,
        );
      this.#writeBrief(id, input.brief, null, now);
    })();
    return this.get(id)!;
  }

  /** Change what was sent. `null` clears the model and the conversation; `undefined` leaves a field. */
  update(
    id: string,
    patch: {
      name?: string;
      conversationId?: string | null;
      model?: string | null;
      schedule?: RoutineSchedule;
      timezone?: string;
      enabled?: boolean;
    },
  ): RoutineRecord | undefined {
    const current = this.get(id);
    if (current === undefined) return undefined;
    this.#db
      .query(
        `UPDATE routine SET name = ?, conversation_id = ?, model = ?, schedule = ?, timezone = ?,
                enabled = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        patch.name ?? current.name,
        patch.conversationId === undefined
          ? current.conversationId
          : patch.conversationId,
        patch.model === undefined ? current.model : patch.model,
        JSON.stringify(patch.schedule ?? current.schedule),
        patch.timezone ?? current.timezone,
        (patch.enabled ?? current.enabled) ? 1 : 0,
        this.#now(),
        id,
      );
    return this.get(id);
  }

  /** The runs, the feedback and the briefs go with it. */
  remove(id: string): boolean {
    return (
      this.#db.query("DELETE FROM routine WHERE id = ?").run(id).changes > 0
    );
  }

  /* ---------------------------------------------------------------- briefs */

  /** The brief in force: the newest version. */
  brief(routineId: string): BriefRecord | undefined {
    const row = this.#db
      .query<BriefRow, [string]>(
        "SELECT * FROM routine_brief WHERE routine_id = ? ORDER BY version DESC LIMIT 1",
      )
      .get(routineId);
    return row === null ? undefined : briefOf(row);
  }

  /** Every version, newest first. */
  briefs(routineId: string): BriefRecord[] {
    return this.#db
      .query<BriefRow, [string]>(
        "SELECT * FROM routine_brief WHERE routine_id = ? ORDER BY version DESC",
      )
      .all(routineId)
      .map(briefOf);
  }

  /** A person's edit: the next version, unless the text is the one already in force. */
  editBrief(routineId: string, text: string): BriefRecord | undefined {
    const current = this.brief(routineId);
    if (current === undefined || current.text === text) return undefined;
    return this.#writeBrief(routineId, text, null, this.#now());
  }

  /** An old version's text, written as the newest. The history still tells the story. */
  restoreBrief(routineId: string, version: number): BriefRecord | undefined {
    const row = this.#db
      .query<BriefRow, [string, number]>(
        "SELECT * FROM routine_brief WHERE routine_id = ? AND version = ?",
      )
      .get(routineId, version);
    if (row === null) return undefined;
    return this.#writeBrief(routineId, row.text, null, this.#now());
  }

  /**
   * A revision from feedback: the next version, pointing at what asked for it. `basedOn` is the
   * version the reviser read; if the brief has moved on since (edited, restored, revised from other
   * feedback) nothing is written and the caller starts again from the newer text.
   */
  reviseBrief(input: {
    routineId: string;
    feedbackId: string;
    text: string;
    basedOn: number;
  }): BriefRecord | undefined {
    const current = this.brief(input.routineId);
    if (current === undefined || current.version !== input.basedOn)
      return undefined;
    return this.#writeBrief(
      input.routineId,
      input.text,
      input.feedbackId,
      this.#now(),
    );
  }

  #writeBrief(
    routineId: string,
    text: string,
    feedbackId: string | null,
    now: number,
  ): BriefRecord {
    const row = this.#db
      .query<BriefRow, [string, string, string, string | null, number]>(
        `INSERT INTO routine_brief (routine_id, version, text, feedback_id, created_at)
         VALUES (?, COALESCE((SELECT MAX(version) FROM routine_brief WHERE routine_id = ?), 0) + 1, ?, ?, ?)
         RETURNING *`,
      )
      .get(routineId, routineId, text, feedbackId, now)!;
    this.#db
      .query("UPDATE routine SET updated_at = ? WHERE id = ?")
      .run(now, routineId);
    return briefOf(row);
  }

  /* ---------------------------------------------------------------- runs */

  /**
   * Start a run, unless the routine already has one going. The unique index is the arbiter: of two
   * triggers that arrive together one gets the run and the other is told there is none.
   */
  startRun(routineId: string, startedBy: RunTrigger): RunRecord | undefined {
    const id = crypto.randomUUID();
    try {
      this.#db
        .query(
          `INSERT INTO routine_run (id, routine_id, started_by, status, started_at)
           VALUES (?, ?, ?, 'running', ?)`,
        )
        .run(id, routineId, startedBy, this.#now());
    } catch (error) {
      if (this.runningRun(routineId) !== undefined) return undefined;
      throw error;
    }
    return this.run(id);
  }

  /** Say which session is doing a run's work. */
  setRunSession(runId: string, sessionId: string): void {
    this.#db
      .query("UPDATE routine_run SET session_id = ? WHERE id = ?")
      .run(sessionId, runId);
  }

  /**
   * End a run. Only a run that is still going can end: the second of two endings (a `finish` and
   * a timeout) is dropped, and says so by returning nothing.
   */
  finishRun(runId: string, outcome: RunOutcome): RunRecord | undefined {
    const report = outcome.status === "sent" ? present(outcome.report) : null;
    const title =
      outcome.status === "sent" && report !== null
        ? (present(outcome.title) ?? titleOf(report))
        : null;
    const changes = this.#db
      .query(
        `UPDATE routine_run SET status = ?, finished_at = ?, title = ?, report = ?, handoff = ?, error = ?
          WHERE id = ? AND status = 'running'`,
      )
      .run(
        outcome.status === "sent" && report === null
          ? "no_news"
          : outcome.status,
        this.#now(),
        title,
        report,
        outcome.status === "failed" ? null : present(outcome.handoff),
        outcome.status === "failed" ? outcome.error : null,
        runId,
      ).changes;
    return changes === 0 ? undefined : this.run(runId);
  }

  run(id: string): RunRecord | undefined {
    const row = this.#db
      .query<RunRow, [string]>("SELECT * FROM routine_run WHERE id = ?")
      .get(id);
    return row === null ? undefined : runOf(row);
  }

  runningRun(routineId: string): RunRecord | undefined {
    const row = this.#db
      .query<RunRow, [string]>(
        "SELECT * FROM routine_run WHERE routine_id = ? AND status = 'running'",
      )
      .get(routineId);
    return row === null ? undefined : runOf(row);
  }

  /** The run a session is doing, while it is going. */
  runningBySession(sessionId: string): RunRecord | undefined {
    const row = this.#db
      .query<RunRow, [string]>(
        "SELECT * FROM routine_run WHERE session_id = ? AND status = 'running'",
      )
      .get(sessionId);
    return row === null ? undefined : runOf(row);
  }

  /** A routine's runs, newest first. */
  runs(routineId: string, limit: number): RunRecord[] {
    return this.#db
      .query<RunRow, [string, number]>(
        `SELECT * FROM routine_run WHERE routine_id = ?
          ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      )
      .all(routineId, limit)
      .map(runOf);
  }

  /** The routine's finished runs that mention a text in their report, handoff or title, or in feedback on them. */
  searchRuns(routineId: string, text: string, limit: number): RunRecord[] {
    const pattern = likeOf(text);
    return this.#db
      .query<RunRow, [string, string, string, string, string, number]>(
        `SELECT r.* FROM routine_run r
          WHERE r.routine_id = ? AND r.status <> 'running'
            AND (r.report LIKE ? ESCAPE '\\' OR r.handoff LIKE ? ESCAPE '\\' OR r.title LIKE ? ESCAPE '\\'
                 OR EXISTS (SELECT 1 FROM routine_feedback f WHERE f.run_id = r.id AND f.text LIKE ? ESCAPE '\\'))
          ORDER BY r.started_at DESC, r.rowid DESC LIMIT ?`,
      )
      .all(routineId, pattern, pattern, pattern, pattern, limit)
      .map(runOf);
  }

  /** The newest handoff anybody wrote: what the next run reads before it starts. */
  handoff(
    routineId: string,
  ): { text: string; runId: string; writtenAt: number } | undefined {
    const row = this.#db
      .query<{ id: string; handoff: string; finished_at: number }, [string]>(
        `SELECT id, handoff, finished_at FROM routine_run
          WHERE routine_id = ? AND finished_at IS NOT NULL AND handoff IS NOT NULL AND handoff <> ''
          ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
      )
      .get(routineId);
    return row === null
      ? undefined
      : { text: row.handoff, runId: row.id, writtenAt: row.finished_at };
  }

  /** The user looked: every finished run of the routine is seen. Returns how many were new. */
  markSeen(routineId: string): number {
    return this.#db
      .query(
        `UPDATE routine_run SET seen_at = ?
          WHERE routine_id = ? AND finished_at IS NOT NULL AND seen_at IS NULL`,
      )
      .run(this.#now(), routineId).changes;
  }

  /** Reports and failures waiting for the user: what a routine's badge counts. */
  unseen(routineId: string): { reports: number; failures: number } {
    const rows = this.#db
      .query<{ status: string; n: number }, [string]>(
        `SELECT status, COUNT(*) AS n FROM routine_run
          WHERE routine_id = ? AND finished_at IS NOT NULL AND seen_at IS NULL
          GROUP BY status`,
      )
      .all(routineId);
    const of = (status: string): number =>
      rows.find((row) => row.status === status)?.n ?? 0;
    return { reports: of("sent"), failures: of("failed") };
  }

  /**
   * Runs a dead process left running end here, as failures that say why. Nothing is running them
   * and a row that said `running` forever would refuse every run after it. Returns their routines.
   */
  recover(reason: string): string[] {
    const rows = this.#db
      .query<{ routine_id: string }, [string, number]>(
        `UPDATE routine_run SET status = 'failed', error = ?, finished_at = ?
          WHERE status = 'running' RETURNING routine_id`,
      )
      .all(reason, this.#now());
    return [...new Set(rows.map((row) => row.routine_id))];
  }

  /* ---------------------------------------------------------------- feedback */

  addFeedback(runId: string, text: string): FeedbackRecord {
    const id = crypto.randomUUID();
    this.#db
      .query(
        "INSERT INTO routine_feedback (id, run_id, text, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(id, runId, text, this.#now());
    return this.feedback(id)!;
  }

  feedback(id: string): FeedbackRecord | undefined {
    const row = this.#db
      .query<FeedbackRow, [string]>(`${FEEDBACK} WHERE f.id = ?`)
      .get(id);
    return row === null ? undefined : feedbackOf(row);
  }

  /** The feedback on a run, oldest first. */
  feedbackOn(runId: string): FeedbackRecord[] {
    return this.#db
      .query<FeedbackRow, [string]>(
        `${FEEDBACK} WHERE f.run_id = ? ORDER BY f.created_at, f.rowid`,
      )
      .all(runId)
      .map(feedbackOf);
  }

  /** Feedback the brief has not been revised from, nor failed to be: oldest first. */
  pendingFeedback(routineId?: string): FeedbackRecord[] {
    return this.#db
      .query<FeedbackRow, [string | null, string | null]>(
        `${FEEDBACK}
          WHERE f.revision_failed = 0 AND b.version IS NULL AND (? IS NULL OR r.routine_id = ?)
          ORDER BY f.created_at, f.rowid`,
      )
      .all(routineId ?? null, routineId ?? null)
      .map(feedbackOf);
  }

  /** A revision that could not be made, recorded so the page can say so and nothing retries it. */
  failRevision(feedbackId: string): void {
    this.#db
      .query("UPDATE routine_feedback SET revision_failed = 1 WHERE id = ?")
      .run(feedbackId);
  }
}
