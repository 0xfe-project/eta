import type { Schedule } from "./schedule";
/**
 * Routines' wire shapes (REFACTOR.md §9, P3.3).
 *
 * AXP's, because the web's routines page reads them: a list of summaries, a routine's page with its
 * briefs, its runs and the handoff, and the two counts that put a badge on it. The translator is
 * where our rows differ — a run's title is the report's first heading, a brief's feedback is the
 * text that revised it, and the schedule is already the browser's own shape.
 */
import type {
  BriefRecord,
  FeedbackRecord,
  RoutineRecord,
  RunRecord,
} from "./store";

interface AxpFeedback {
  id: string;
  text: string;
  created_at: string;
  /** The brief version it led to; null while the revision runs. */
  brief_version: number | null;
  revision_failed: boolean;
}

interface AxpRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  /** The report's first heading, when it sent one. */
  title: string | null;
  report: string | null;
  error: string | null;
  feedback: AxpFeedback[];
}

interface AxpListedRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  title: string | null;
}

interface AxpBrief {
  version: number;
  text: string;
  created_at: string;
  /** The feedback that revised it; null when the user wrote it. */
  feedback: string | null;
}

interface AxpHandoff {
  text: string;
  written_at: string;
}

export interface AxpRoutineSummary {
  id: string;
  name: string;
  model: string;
  schedule: Schedule;
  timezone: string;
  enabled: boolean;
  next_run_at: string | null;
  runs: AxpListedRun[];
  /** Feedback on one of its runs is being made into a new brief. */
  revising: boolean;
  unseen_reports: number;
  unseen_failures: number;
}

export interface AxpRoutine {
  id: string;
  name: string;
  model: string;
  schedule: Schedule;
  timezone: string;
  enabled: boolean;
  next_run_at: string | null;
  briefs: AxpBrief[];
  handoff: AxpHandoff | null;
  runs: AxpRun[];
}

export interface RoutineShapeInput {
  /** The feedback texts, by id: a brief points at the feedback that revised it. */
  feedbackText: (feedbackId: string) => string | undefined;
  /** When it runs next, from its own schedule and zone. */
  nextRunAt: (routine: RoutineRecord) => Date | undefined;
  /** Whether a revision is in flight for this routine. */
  revising: (routineId: string) => boolean;
  /** A run's feedback, oldest first. */
  feedbackOf: (runId: string) => FeedbackRecord[];
  /** The brief version a piece of feedback led to, when it did. */
  briefVersionOf: (feedbackId: string) => number | undefined;
}

/** A report's first heading, which is what a list shows instead of the whole thing. */
function titleOf(report: string | undefined): string | null {
  if (report === undefined) return null;
  for (const line of report.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#"))
      return trimmed.replace(/^#+\s*/, "").slice(0, 120);
  }
  const first = report.split("\n").find((line) => line.trim().length > 0);
  return first === undefined ? null : first.trim().slice(0, 120);
}

const toFeedback = (
  feedback: FeedbackRecord,
  input: RoutineShapeInput,
): AxpFeedback => ({
  id: feedback.id,
  text: feedback.text,
  created_at: feedback.createdAt,
  brief_version: input.briefVersionOf(feedback.id) ?? null,
  revision_failed: feedback.revisionFailed,
});

const toRun = (run: RunRecord, input: RoutineShapeInput): AxpRun => ({
  id: run.id,
  started_at: run.startedAt,
  finished_at: run.finishedAt ?? null,
  status: run.status,
  title: titleOf(run.report),
  report: run.report ?? null,
  error: run.error ?? null,
  feedback: input
    .feedbackOf(run.id)
    .map((feedback) => toFeedback(feedback, input)),
});

const toListedRun = (run: RunRecord): AxpListedRun => ({
  id: run.id,
  started_at: run.startedAt,
  finished_at: run.finishedAt ?? null,
  status: run.status,
  title: titleOf(run.report),
});

const toBrief = (brief: BriefRecord, input: RoutineShapeInput): AxpBrief => ({
  version: brief.version,
  text: brief.text,
  created_at: brief.createdAt,
  feedback:
    brief.feedbackId === undefined
      ? null
      : (input.feedbackText(brief.feedbackId) ?? null),
});

export function toRoutineSummary(
  routine: RoutineRecord,
  input: RoutineShapeInput & {
    runs: RunRecord[];
    unseen: { reports: number; failures: number };
  },
): AxpRoutineSummary {
  const next = input.nextRunAt(routine);
  return {
    id: routine.id,
    name: routine.name,
    model: routine.model,
    schedule: routine.schedule,
    timezone: routine.timezone,
    enabled: routine.enabled,
    next_run_at: next === undefined ? null : next.toISOString(),
    runs: input.runs.map(toListedRun),
    revising: input.revising(routine.id),
    unseen_reports: input.unseen.reports,
    unseen_failures: input.unseen.failures,
  };
}

export function toRoutine(
  routine: RoutineRecord,
  input: RoutineShapeInput & {
    briefs: BriefRecord[];
    runs: RunRecord[];
    handoff: { text: string; writtenAt: string } | undefined;
  },
): AxpRoutine {
  const next = input.nextRunAt(routine);
  return {
    id: routine.id,
    name: routine.name,
    model: routine.model,
    schedule: routine.schedule,
    timezone: routine.timezone,
    enabled: routine.enabled,
    next_run_at: next === undefined ? null : next.toISOString(),
    briefs: input.briefs.map((brief) => toBrief(brief, input)),
    handoff:
      input.handoff === undefined
        ? null
        : { text: input.handoff.text, written_at: input.handoff.writtenAt },
    runs: input.runs.map((run) => toRun(run, input)),
  };
}
