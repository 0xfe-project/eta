/**
 * Routines: work Captain does on a schedule, and the reports it leaves.
 *
 * Two kinds of target. `routines` is eager and publishes the `list` section, a summary of every
 * routine with its latest runs, and `status`, whether Captain is on to run them; every routine is
 * a target of its own (`routines.<id>`) with the brief versions and the runs in full. A run is one
 * new Captain session; `RunListing.sessionId` names it.
 *
 * What a run leaves for the next one (its handoff) is Captain's private note to itself. It is in
 * no view here and never reaches a client: the next run's prompt is the only thing that reads it.
 *
 * Times are epoch milliseconds. A schedule is one of the four shapes the page offers, read in the
 * routine's own time zone; the next run is computed from it, never stored.
 */
import type { CallFrame } from "@eta/client-wire-proto";

/* ------------------------------------------------------------------ views */

/** Every day at `time` (`HH:MM`, 24 hours) in the routine's zone. */
export interface DailySchedule {
  kind: "daily";
  time: string;
}
/** On the given weekdays (0 is Sunday, as in cron) at `time`. */
export interface WeeklySchedule {
  kind: "weekly";
  days: number[];
  time: string;
}
/** At minute zero of the hours that `every` divides, by the zone's wall clock. */
export interface HourlySchedule {
  kind: "hourly";
  every: HourlyStep;
}
/** Five fields: minute hour day-of-month month day-of-week. */
export interface CronSchedule {
  kind: "cron";
  cron: string;
}
export type RoutineSchedule =
  | DailySchedule
  | WeeklySchedule
  | HourlySchedule
  | CronSchedule;

/** The steps `hourly` may take: the ones that divide a day. */
export const HOURLY_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;
export type HourlyStep = (typeof HOURLY_STEPS)[number];

/**
 * Where a run stands. It ends `sent` (it reported), `no_news` (it looked and had nothing new) or
 * `failed` (`error` says why). `skipped` never ran: its time came while Captain was off, and
 * `error` says so.
 */
export type RunStatus = "running" | "sent" | "no_news" | "failed" | "skipped";

/** Who started a run: the clock, or a person who pressed "run now". */
export type RunTrigger = "schedule" | "user";

/** A run as the lists show it: no report, no feedback. */
export interface RunListing {
  id: string;
  routineId: string;
  startedBy: RunTrigger;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  /** What the run called its report, or the report's first heading. Null when it sent none. */
  title: string | null;
  /** The session that ran it, for reading what it did. */
  sessionId: string | null;
}

/** The user's words about one run; the brief is revised from them in the background. */
export interface FeedbackView {
  id: string;
  runId: string;
  text: string;
  createdAt: number;
  /** The brief version it led to; null while the revision is still to come. */
  briefVersion: number | null;
  /** The revision could not be made; the brief stayed as it was. */
  revisionFailed: boolean;
}

/** A run with what it left for the user. Its handoff to the next run is not here, on purpose. */
export interface RunView extends RunListing {
  report: string | null;
  error: string | null;
  /** When the user last looked at it; null while it waits for them. */
  seenAt: number | null;
  /** Oldest first. */
  feedback: FeedbackView[];
}

/** One version of the brief. A new version is written, never an edit: the old ones stay. */
export interface BriefView {
  version: number;
  text: string;
  createdAt: number;
  /** The text of the feedback this version was revised from; null when a person wrote it. */
  feedback: string | null;
}

/** What identifies and schedules a routine (the `info` section; the list rows add the runs). */
export interface RoutineInfo {
  id: string;
  name: string;
  schedule: RoutineSchedule;
  timezone: string;
  enabled: boolean;
  /** When the clock runs it next; null while it is paused or has no further time. */
  nextRunAt: number | null;
  /** Feedback on one of its runs is being made into a new brief. */
  revising: boolean;
  /** Finished runs the user has not looked at (`routines.seen` clears them). */
  unseenReports: number;
  unseenFailures: number;
  createdAt: number;
  updatedAt: number;
}

/** One row of the routine list. */
export interface RoutineSummary extends RoutineInfo {
  /** The latest runs, newest first. */
  runs: RunListing[];
}

/* ------------------------------------------------------------------ sections */

/**
 * Why Captain cannot run routines now: its supervisor is switched off, or it has no model (or no
 * Captain exists yet). While it is off, a time that comes is recorded as a `skipped` run.
 */
export type RoutinesPausedReason = "supervisor_off" | "no_model" | "no_captain";

/** Whether routines run: they are Captain's, so they run when Captain does. */
export interface RoutinesStatus {
  captainOn: boolean;
  /** Null while Captain is on. */
  reason: RoutinesPausedReason | null;
}

export interface RoutinesSections {
  list: RoutineSummary[];
  status: RoutinesStatus;
}
/** `routines.<id>`: registered for every routine, from startup or from its creation. */
export interface RoutineSections {
  info: RoutineInfo;
  /** Newest version first. */
  briefs: BriefView[];
  /** Newest first, with their reports and feedback. */
  runs: RunView[];
}

/* ------------------------------------------------------------------ actions */

export const ROUTINE_ACTIONS = [
  "create",
  "update",
  "delete",
  "run",
  "seen",
  "feedback",
  "restoreBrief",
] as const;
export type RoutineAction = (typeof ROUTINE_ACTIONS)[number];

export interface RoutineFields {
  name: string;
  /** What each run is asked to do. Becomes version 1 of the brief. */
  brief: string;
  schedule: RoutineSchedule;
  /** An IANA zone, for example `Asia/Shanghai`. */
  timezone: string;
}

/** Valid requests from a client. The server still validates untrusted JSON at runtime. */
export interface RoutineArgs {
  /** On the clock from the moment it exists, unless `enabled` is false. */
  create: RoutineFields & { enabled?: boolean };
  /** A `brief` that differs from the newest version is written as the next one. */
  update: { routineId: string } & Partial<RoutineFields> & {
      enabled?: boolean;
    };
  /** Refused while a run is going. Its working directory is left on disk. */
  delete: { routineId: string };
  /** Starts a run now, paused or not. Refused while one is going, or while Captain is off. */
  run: { routineId: string };
  /** The user looked at the finished runs: clears the unseen counts. */
  seen: { routineId: string };
  /** Feedback on a finished run; the brief is revised from it in the background. */
  feedback: { routineId: string; runId: string; text: string };
  /** Writes an old version's text as the newest one. */
  restoreBrief: { routineId: string; version: number };
}
export interface RoutineResults {
  create: { routine: RoutineSummary };
  update: { routine: RoutineSummary };
  delete: { routineId: string };
  /** The run is under way when this returns; its outcome arrives as state. */
  run: { routine: RoutineSummary; run: RunListing };
  seen: { routine: RoutineSummary };
  feedback: { feedback: FeedbackView };
  restoreBrief: { brief: BriefView };
}
export type RoutineCall = {
  [A in RoutineAction]: Omit<CallFrame, "target" | "action" | "args"> & {
    target: "routines";
    action: A;
    args: RoutineArgs[A];
  };
}[RoutineAction];
