/**
 * The routines' rows: the routine, the versions of its brief, its runs, the feedback on them,
 * external trigger bindings (`routine_trigger`), and the coalescing event queue
 * (`routine_trigger_event`).
 *
 * Two rules live in the schema because they must hold even when two callers race: a routine runs
 * once at a time (a partial unique index on the one running row) and a piece of feedback leads to
 * at most one brief version. A third rule — event idempotency — lives in `UNIQUE(routine_id,
 * event_id)`. The rest of what this file does is statements; when a thing happens is the runner's,
 * the clock's, and the trigger hub's business, never this file's.
 */
import type {
  RoutineSchedule,
  RoutineTrigger,
  RoutineTriggerMode,
  RoutineTriggerStatus,
  RoutineTriggerView,
  RunStatus,
  RunTrigger,
} from "@eta/client-contracts";
import type { Database } from "bun:sqlite";

export interface RoutineRecord {
  id: string;
  name: string;
  schedule: RoutineSchedule | null;
  timezone: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineTriggerRecord {
  routineId: string;
  provider: string;
  source: string;
  triggerSlug: string;
  accountId: string | null;
  config: Record<string, unknown>;
  requestedMode: RoutineTriggerMode | null;
  requestedPollingInterval: number | null;
  instanceId: string | null;
  effectiveMode: RoutineTriggerMode | null;
  pollingInterval: number | null;
  fallbackReason: string | null;
  status: RoutineTriggerStatus;
  lastError: string | null;
  lastEventAt: number | null;
  lastCheckedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

type TriggerEventState =
  | "pending"
  | "dispatched"
  | "done"
  | "dropped"
  | "expired";

export interface TriggerEventRecord {
  id: string;
  routineId: string;
  provider: string;
  eventId: string;
  instanceId: string | null;
  triggerSlug: string;
  occurredAt: number;
  receivedAt: number;
  payload: unknown;
  state: TriggerEventState;
  runId: string | null;
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

/**
 * What a run ends with. A report makes it `sent`; none makes it `no_news` unless it failed. The
 * handoff, the run's note to the next one, is kept whichever way it ended.
 */
export type RunOutcome =
  | { status: "sent"; report: string; title?: string; handoff?: string }
  | { status: "no_news"; handoff?: string }
  | { status: "failed"; error: string; handoff?: string };

interface RoutineRow {
  id: string;
  name: string;
  schedule: string | null;
  timezone: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface TriggerRow {
  routine_id: string;
  provider: string;
  source: string;
  trigger_slug: string;
  account_id: string | null;
  config_json: string;
  requested_mode: string | null;
  requested_polling_interval: number | null;
  instance_id: string | null;
  effective_mode: string | null;
  polling_interval: number | null;
  fallback_reason: string | null;
  status: string;
  last_error: string | null;
  last_event_at: number | null;
  last_checked_at: number | null;
  created_at: number;
  updated_at: number;
}

interface TriggerEventRow {
  id: string;
  routine_id: string;
  provider: string;
  event_id: string;
  instance_id: string | null;
  trigger_slug: string;
  occurred_at: number;
  received_at: number;
  payload_json: string;
  state: string;
  run_id: string | null;
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

const DEFAULT_EVENT_TTL_MS = 24 * 60 * 60_000;

const parseJsonObject = (raw: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const parseJsonValue = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

const routineOf = (row: RoutineRow): RoutineRecord => ({
  id: row.id,
  name: row.name,
  // Written only through `parseSchedule`, so it reads back as what it was (or null for trigger-only).
  schedule:
    row.schedule === null
      ? null
      : (JSON.parse(row.schedule) as RoutineSchedule),
  timezone: row.timezone,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const triggerOf = (row: TriggerRow): RoutineTriggerRecord => ({
  routineId: row.routine_id,
  provider: row.provider,
  source: row.source,
  triggerSlug: row.trigger_slug,
  accountId: row.account_id,
  config: parseJsonObject(row.config_json),
  requestedMode: row.requested_mode as RoutineTriggerMode | null,
  requestedPollingInterval: row.requested_polling_interval,
  instanceId: row.instance_id,
  effectiveMode: row.effective_mode as RoutineTriggerMode | null,
  pollingInterval: row.polling_interval,
  fallbackReason: row.fallback_reason,
  status: row.status as RoutineTriggerStatus,
  lastError: row.last_error,
  lastEventAt: row.last_event_at,
  lastCheckedAt: row.last_checked_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const triggerViewOf = (record: RoutineTriggerRecord): RoutineTriggerView => ({
  provider: record.provider,
  source: record.source,
  trigger: record.triggerSlug,
  accountId: record.accountId,
  config: record.config,
  instanceId: record.instanceId,
  mode: record.effectiveMode ?? record.requestedMode,
  pollingIntervalMinutes:
    record.pollingInterval ?? record.requestedPollingInterval,
  fallbackReason: record.fallbackReason,
  status: record.status,
  lastError: record.lastError,
  lastEventAt: record.lastEventAt,
  lastCheckedAt: record.lastCheckedAt,
});

const triggerEventOf = (row: TriggerEventRow): TriggerEventRecord => ({
  id: row.id,
  routineId: row.routine_id,
  provider: row.provider,
  eventId: row.event_id,
  instanceId: row.instance_id,
  triggerSlug: row.trigger_slug,
  occurredAt: row.occurred_at,
  receivedAt: row.received_at,
  payload: parseJsonValue(row.payload_json),
  state: row.state as TriggerEventState,
  runId: row.run_id,
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

  /** The ones that are turned on. */
  enabled(): RoutineRecord[] {
    return this.list().filter((routine) => routine.enabled);
  }

  get(id: string): RoutineRecord | undefined {
    const row = this.#db
      .query<RoutineRow, [string]>("SELECT * FROM routine WHERE id = ?")
      .get(id);
    return row === null ? undefined : routineOf(row);
  }

  /** A routine and its first brief (and optional trigger) appear together or not at all. */
  create(input: {
    name: string;
    brief: string;
    schedule: RoutineSchedule | null;
    trigger?: RoutineTrigger | null;
    timezone: string;
    enabled: boolean;
  }): RoutineRecord {
    const id = crypto.randomUUID();
    const now = this.#now();
    this.#db.transaction(() => {
      this.#db
        .query(
          `INSERT INTO routine (id, name, schedule, timezone, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.schedule === null ? null : JSON.stringify(input.schedule),
          input.timezone,
          input.enabled ? 1 : 0,
          now,
          now,
        );
      this.#writeBrief(id, input.brief, null, now);
      if (input.trigger !== undefined && input.trigger !== null)
        this.#writeTrigger(id, input.trigger, now);
    })();
    return this.get(id)!;
  }

  /** Change what was sent; `undefined` leaves a field, `null` clears schedule or trigger. */
  update(
    id: string,
    patch: {
      name?: string;
      schedule?: RoutineSchedule | null;
      trigger?: RoutineTrigger | null;
      timezone?: string;
      enabled?: boolean;
    },
  ): RoutineRecord | undefined {
    const current = this.get(id);
    if (current === undefined) return undefined;
    const now = this.#now();
    const nextSchedule =
      patch.schedule === undefined ? current.schedule : patch.schedule;
    this.#db.transaction(() => {
      this.#db
        .query(
          `UPDATE routine SET name = ?, schedule = ?, timezone = ?, enabled = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          patch.name ?? current.name,
          nextSchedule === null ? null : JSON.stringify(nextSchedule),
          patch.timezone ?? current.timezone,
          (patch.enabled ?? current.enabled) ? 1 : 0,
          now,
          id,
        );
      if (patch.trigger === null) {
        this.#db
          .query("DELETE FROM routine_trigger WHERE routine_id = ?")
          .run(id);
      } else if (patch.trigger !== undefined) {
        this.#writeTrigger(id, patch.trigger, now);
      }
    })();
    return this.get(id);
  }

  /** The runs, the feedback, the briefs, the trigger and queued events go with it. */
  remove(id: string): boolean {
    return (
      this.#db.query("DELETE FROM routine WHERE id = ?").run(id).changes > 0
    );
  }

  /* --------------------------------------------------------------- triggers */

  trigger(routineId: string): RoutineTriggerRecord | undefined {
    const row = this.#db
      .query<TriggerRow, [string]>(
        "SELECT * FROM routine_trigger WHERE routine_id = ?",
      )
      .get(routineId);
    return row === null ? undefined : triggerOf(row);
  }

  triggerView(routineId: string): RoutineTriggerView | undefined {
    const record = this.trigger(routineId);
    return record === undefined ? undefined : triggerViewOf(record);
  }

  triggers(provider?: string): RoutineTriggerRecord[] {
    if (provider === undefined)
      return this.#db
        .query<TriggerRow, []>(
          "SELECT * FROM routine_trigger ORDER BY created_at, routine_id",
        )
        .all()
        .map(triggerOf);
    return this.#db
      .query<TriggerRow, [string]>(
        "SELECT * FROM routine_trigger WHERE provider = ? ORDER BY created_at, routine_id",
      )
      .all(provider)
      .map(triggerOf);
  }

  updateTriggerState(
    routineId: string,
    patch: {
      accountId?: string | null;
      instanceId?: string | null;
      effectiveMode?: RoutineTriggerMode | null;
      pollingInterval?: number | null;
      fallbackReason?: string | null;
      status?: RoutineTriggerStatus;
      lastError?: string | null;
      lastEventAt?: number | null;
      lastCheckedAt?: number | null;
    },
  ): RoutineTriggerRecord | undefined {
    const current = this.trigger(routineId);
    if (current === undefined) return undefined;
    const now = this.#now();
    this.#db
      .query(
        `UPDATE routine_trigger
            SET account_id = ?,
                instance_id = ?,
                effective_mode = ?,
                polling_interval = ?,
                fallback_reason = ?,
                status = ?,
                last_error = ?,
                last_event_at = ?,
                last_checked_at = ?,
                updated_at = ?
          WHERE routine_id = ?`,
      )
      .run(
        patch.accountId === undefined ? current.accountId : patch.accountId,
        patch.instanceId === undefined ? current.instanceId : patch.instanceId,
        patch.effectiveMode === undefined
          ? current.effectiveMode
          : patch.effectiveMode,
        patch.pollingInterval === undefined
          ? current.pollingInterval
          : patch.pollingInterval,
        patch.fallbackReason === undefined
          ? current.fallbackReason
          : patch.fallbackReason,
        patch.status ?? current.status,
        patch.lastError === undefined ? current.lastError : patch.lastError,
        patch.lastEventAt === undefined
          ? current.lastEventAt
          : patch.lastEventAt,
        patch.lastCheckedAt === undefined
          ? current.lastCheckedAt
          : patch.lastCheckedAt,
        now,
        routineId,
      );
    return this.trigger(routineId);
  }

  countSharedInstance(
    provider: string,
    instanceId: string,
    excludeRoutineId: string,
    options?: { enabledOnly?: boolean },
  ): number {
    if (options?.enabledOnly === true) {
      return (
        this.#db
          .query<{ n: number }, [string, string, string]>(
            `SELECT COUNT(*) AS n
               FROM routine_trigger t
               JOIN routine r ON r.id = t.routine_id
              WHERE t.provider = ? AND t.instance_id = ? AND t.routine_id <> ? AND r.enabled = 1`,
          )
          .get(provider, instanceId, excludeRoutineId)?.n ?? 0
      );
    }
    return (
      this.#db
        .query<{ n: number }, [string, string, string]>(
          `SELECT COUNT(*) AS n FROM routine_trigger
            WHERE provider = ? AND instance_id = ? AND routine_id <> ?`,
        )
        .get(provider, instanceId, excludeRoutineId)?.n ?? 0
    );
  }

  findTriggerRoutines(match: {
    provider: string;
    instanceId?: string | null;
    routineId?: string | null;
    source?: string | null;
    triggerSlug?: string | null;
    accountId?: string | null;
  }): RoutineRecord[] {
    if (match.routineId != null) {
      const row = this.#db
        .query<RoutineRow, [string, string]>(
          `SELECT r.* FROM routine r
             JOIN routine_trigger t ON t.routine_id = r.id
            WHERE r.id = ? AND t.provider = ?`,
        )
        .get(match.routineId, match.provider);
      return row === null ? [] : [routineOf(row)];
    }
    if (match.instanceId != null) {
      return this.#db
        .query<RoutineRow, [string, string]>(
          `SELECT r.* FROM routine r
             JOIN routine_trigger t ON t.routine_id = r.id
            WHERE t.provider = ? AND t.instance_id = ?
            ORDER BY r.created_at, r.id`,
        )
        .all(match.provider, match.instanceId)
        .map(routineOf);
    }
    if (match.triggerSlug != null) {
      return this.#db
        .query<
          RoutineRow,
          [
            string,
            string,
            string | null,
            string | null,
            string | null,
            string | null,
          ]
        >(
          `SELECT r.* FROM routine r
             JOIN routine_trigger t ON t.routine_id = r.id
            WHERE t.provider = ? AND t.trigger_slug = ?
              AND (? IS NULL OR t.source = ?)
              AND (? IS NULL OR t.account_id IS NULL OR t.account_id = ?)
            ORDER BY r.created_at, r.id`,
        )
        .all(
          match.provider,
          match.triggerSlug,
          match.source ?? null,
          match.source ?? null,
          match.accountId ?? null,
          match.accountId ?? null,
        )
        .map(routineOf);
    }
    return [];
  }

  #writeTrigger(routineId: string, trigger: RoutineTrigger, now: number): void {
    const existing = this.trigger(routineId);
    this.#db
      .query(
        `INSERT INTO routine_trigger (
           routine_id, provider, source, trigger_slug, account_id, config_json,
           requested_mode, requested_polling_interval, instance_id, effective_mode,
           polling_interval, fallback_reason, status, last_error, last_event_at,
           last_checked_at, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'disabled', NULL, ?, NULL, ?, ?)
         ON CONFLICT(routine_id) DO UPDATE SET
           provider = excluded.provider,
           source = excluded.source,
           trigger_slug = excluded.trigger_slug,
           account_id = excluded.account_id,
           config_json = excluded.config_json,
           requested_mode = excluded.requested_mode,
           requested_polling_interval = excluded.requested_polling_interval,
           instance_id = NULL,
           effective_mode = NULL,
           polling_interval = NULL,
           fallback_reason = NULL,
           status = 'disabled',
           last_error = NULL,
           last_checked_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(
        routineId,
        trigger.provider,
        trigger.source,
        trigger.trigger,
        trigger.accountId ?? null,
        JSON.stringify(trigger.config ?? {}),
        trigger.mode ?? null,
        trigger.pollingIntervalMinutes ?? null,
        existing?.lastEventAt ?? null,
        existing?.createdAt ?? now,
        now,
      );
  }

  /* --------------------------------------------------------- trigger events */

  enqueueTriggerEvent(input: {
    routineId: string;
    provider: string;
    eventId: string;
    instanceId: string | null;
    triggerSlug: string;
    occurredAt: number;
    payloadJson: string;
    ttlMs: number;
    maxPending: number;
  }): { inserted: boolean; expired: number; dropped: number } {
    const now = this.#now();
    const id = crypto.randomUUID();
    return this.#db.transaction(() => {
      const inserted =
        this.#db
          .query(
            `INSERT INTO routine_trigger_event (
               id, routine_id, provider, event_id, instance_id, trigger_slug,
               occurred_at, received_at, payload_json, state, run_id
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL)
             ON CONFLICT(routine_id, event_id) DO NOTHING`,
          )
          .run(
            id,
            input.routineId,
            input.provider,
            input.eventId,
            input.instanceId,
            input.triggerSlug,
            input.occurredAt,
            now,
            input.payloadJson,
          ).changes > 0;
      if (!inserted) return { inserted: false, expired: 0, dropped: 0 };

      this.#db
        .query(
          "UPDATE routine_trigger SET last_event_at = ?, updated_at = ? WHERE routine_id = ?",
        )
        .run(now, now, input.routineId);

      const expired = this.#expirePending(input.routineId, now - input.ttlMs);
      const pending = this.#db
        .query<{ id: string }, [string]>(
          `SELECT id FROM routine_trigger_event
            WHERE routine_id = ? AND state = 'pending'
            ORDER BY occurred_at DESC, received_at DESC, rowid DESC`,
        )
        .all(input.routineId);
      let dropped = 0;
      if (pending.length > input.maxPending) {
        const overflow = pending.slice(input.maxPending);
        const markDropped = this.#db.query(
          "UPDATE routine_trigger_event SET state = 'dropped' WHERE id = ? AND state = 'pending'",
        );
        for (const row of overflow) dropped += markDropped.run(row.id).changes;
      }
      return { inserted: true, expired, dropped };
    })();
  }

  claimTriggerBatch(input: {
    routineId: string;
    ttlMs: number;
    maxBatch: number;
  }):
    | { run: RunRecord; events: TriggerEventRecord[]; droppedCount: number }
    | undefined {
    const now = this.#now();
    return this.#db.transaction(() => {
      this.#expirePending(input.routineId, now - input.ttlMs);
      const pending = this.#db
        .query<TriggerEventRow, [string]>(
          `SELECT * FROM routine_trigger_event
            WHERE routine_id = ? AND state = 'pending'
            ORDER BY occurred_at ASC, received_at ASC, rowid ASC`,
        )
        .all(input.routineId);
      if (pending.length === 0) return undefined;

      const run = this.startRun(input.routineId, "trigger");
      if (run === undefined) return undefined;

      let batch = pending;
      if (pending.length > input.maxBatch) {
        const overflow = pending.slice(0, pending.length - input.maxBatch);
        const markDropped = this.#db.query(
          "UPDATE routine_trigger_event SET state = 'dropped' WHERE id = ? AND state = 'pending'",
        );
        for (const row of overflow) markDropped.run(row.id);
        batch = pending.slice(-input.maxBatch);
      }

      const droppedCount =
        this.#db
          .query<{ n: number }, [string]>(
            `SELECT COUNT(*) AS n FROM routine_trigger_event
              WHERE routine_id = ? AND state = 'dropped' AND run_id IS NULL`,
          )
          .get(input.routineId)?.n ?? 0;

      const markDispatched = this.#db.query(
        "UPDATE routine_trigger_event SET state = 'dispatched', run_id = ? WHERE id = ?",
      );
      for (const row of batch) markDispatched.run(run.id, row.id);

      if (droppedCount > 0) {
        this.#db
          .query(
            `UPDATE routine_trigger_event SET run_id = ?
              WHERE routine_id = ? AND state = 'dropped' AND run_id IS NULL`,
          )
          .run(run.id, input.routineId);
      }

      return {
        run,
        events: batch.map(triggerEventOf),
        droppedCount,
      };
    })();
  }

  pendingTriggerRoutines(ttlMs = DEFAULT_EVENT_TTL_MS): string[] {
    const cutoff = this.#now() - ttlMs;
    return this.#db
      .query<{ routine_id: string }, [number]>(
        `SELECT DISTINCT e.routine_id
           FROM routine_trigger_event e
           JOIN routine r ON r.id = e.routine_id
          WHERE e.state = 'pending' AND e.received_at >= ? AND r.enabled = 1
          ORDER BY e.received_at, e.routine_id`,
      )
      .all(cutoff)
      .map((row) => row.routine_id);
  }

  triggerEventsOfRoutine(routineId: string): TriggerEventRecord[] {
    return this.#db
      .query<TriggerEventRow, [string]>(
        `SELECT * FROM routine_trigger_event
          WHERE routine_id = ?
          ORDER BY occurred_at ASC, received_at ASC, rowid ASC`,
      )
      .all(routineId)
      .map(triggerEventOf);
  }

  triggerEventsOfRun(runId: string): TriggerEventRecord[] {
    return this.#db
      .query<TriggerEventRow, [string]>(
        `SELECT * FROM routine_trigger_event
          WHERE run_id = ? AND state IN ('dispatched', 'done')
          ORDER BY occurred_at ASC, received_at ASC, rowid ASC`,
      )
      .all(runId)
      .map(triggerEventOf);
  }

  #expirePending(routineId: string, cutoff: number): number {
    return this.#db
      .query(
        `UPDATE routine_trigger_event SET state = 'expired'
          WHERE routine_id = ? AND state = 'pending' AND received_at < ?`,
      )
      .run(routineId, cutoff).changes;
  }

  expireAllPending(routineId: string): number {
    return this.#db
      .query(
        `UPDATE routine_trigger_event SET state = 'expired'
          WHERE routine_id = ? AND state = 'pending'`,
      )
      .run(routineId).changes;
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

  /**
   * A time that came while the run could not happen (Captain was off): a run that is over as soon
   * as it is written, `skipped`, with the reason. It takes no slot, so it never races a real run.
   */
  skipRun(routineId: string, startedBy: RunTrigger, reason: string): RunRecord {
    const id = crypto.randomUUID();
    const now = this.#now();
    this.#db
      .query(
        `INSERT INTO routine_run (id, routine_id, started_by, status, started_at, finished_at, error)
         VALUES (?, ?, ?, 'skipped', ?, ?, ?)`,
      )
      .run(id, routineId, startedBy, now, now, reason);
    return this.run(id)!;
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
  finishRun(
    runId: string,
    outcome: RunOutcome,
    options?: { keepTriggerEventsPending?: boolean; eventTtlMs?: number },
  ): RunRecord | undefined {
    const report = outcome.status === "sent" ? present(outcome.report) : null;
    const title =
      outcome.status === "sent" && report !== null
        ? (present(outcome.title) ?? titleOf(report))
        : null;
    const now = this.#now();
    return this.#db.transaction(() => {
      const changes = this.#db
        .query(
          `UPDATE routine_run SET status = ?, finished_at = ?, title = ?, report = ?, handoff = ?, error = ?
            WHERE id = ? AND status = 'running'`,
        )
        .run(
          outcome.status === "sent" && report === null
            ? "no_news"
            : outcome.status,
          now,
          title,
          report,
          // A run that failed after leaving a note still leaves it: the next run reads it.
          present(outcome.handoff),
          outcome.status === "failed" ? outcome.error : null,
          runId,
        ).changes;
      if (changes === 0) return undefined;
      if (options?.keepTriggerEventsPending === true) {
        const cutoff = now - (options.eventTtlMs ?? DEFAULT_EVENT_TTL_MS);
        this.#db
          .query(
            `UPDATE routine_trigger_event
                SET state = CASE WHEN received_at >= ? THEN 'pending' ELSE 'expired' END,
                    run_id = NULL
              WHERE run_id = ? AND state = 'dispatched'`,
          )
          .run(cutoff, runId);
      } else {
        this.#db
          .query(
            `UPDATE routine_trigger_event SET state = 'done'
              WHERE run_id = ? AND state = 'dispatched'`,
          )
          .run(runId);
      }
      return this.run(runId);
    })();
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

  /**
   * The routine's finished runs that mention a text in their report or title, or in feedback on
   * them. Not in a handoff: that is read by the next run's prompt and by nothing else.
   */
  searchRuns(routineId: string, text: string, limit: number): RunRecord[] {
    const pattern = likeOf(text);
    return this.#db
      .query<RunRow, [string, string, string, string, number]>(
        `SELECT r.* FROM routine_run r
          WHERE r.routine_id = ? AND r.status NOT IN ('running', 'skipped')
            AND (r.report LIKE ? ESCAPE '\\' OR r.title LIKE ? ESCAPE '\\'
                 OR EXISTS (SELECT 1 FROM routine_feedback f WHERE f.run_id = r.id AND f.text LIKE ? ESCAPE '\\'))
          ORDER BY r.started_at DESC, r.rowid DESC LIMIT ?`,
      )
      .all(routineId, pattern, pattern, pattern, limit)
      .map(runOf);
  }

  /**
   * The newest handoff a run wrote: what the next run reads before it starts. Its only reader is
   * the run prompt (`runner.ts`); no view, tool or notification is made from it.
   */
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
   * and a row that said `running` forever would refuse every run after it. Also restores any
   * `dispatched` trigger events belonging to interrupted runs (that are still within TTL) back to
   * `pending` so the queue never gets wedged across restarts. Returns the affected routine ids.
   */
  recover(reason: string, eventTtlMs = DEFAULT_EVENT_TTL_MS): string[] {
    const now = this.#now();
    const cutoff = now - eventTtlMs;
    return this.#db.transaction(() => {
      const rows = this.#db
        .query<{ routine_id: string }, [string, number]>(
          `UPDATE routine_run SET status = 'failed', error = ?, finished_at = ?
            WHERE status = 'running' RETURNING routine_id`,
        )
        .all(reason, now);

      // Reclaim dispatched events of runs interrupted by a crash or shutdown (unless expired).
      this.#db
        .query(
          `UPDATE routine_trigger_event
              SET state = CASE WHEN received_at >= ? THEN 'pending' ELSE 'expired' END,
                  run_id = NULL
            WHERE state = 'dispatched'
              AND (
                run_id IS NULL
                OR EXISTS (
                  SELECT 1 FROM routine_run rr
                   WHERE rr.id = routine_trigger_event.run_id
                     AND rr.status = 'failed'
                     AND rr.error = ?
                )
              )`,
        )
        .run(cutoff, reason);

      // Any remaining dispatched events pointing at a run that already settled normally become done.
      this.#db
        .query(
          `UPDATE routine_trigger_event
              SET state = 'done'
            WHERE state = 'dispatched'
              AND NOT EXISTS (
                SELECT 1 FROM routine_run rr
                 WHERE rr.id = routine_trigger_event.run_id
                   AND rr.status = 'running'
              )`,
        )
        .run();

      return [...new Set(rows.map((row) => row.routine_id))];
    })();
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
