/**
 * Routines as the wire shows them. Every view is a read of the rows, so a view can never disagree
 * with the database; the only thing computed is the next run, from the schedule and the clock.
 */
import type {
  BriefView,
  FeedbackView,
  HandoffView,
  RoutineInfo,
  RoutineSummary,
  RunListing,
  RunView,
} from "@eta/client-contracts";
import type {
  BriefRecord,
  FeedbackRecord,
  RoutineRecord,
  RoutineStore,
  RunRecord,
} from "./store";
import { nextRunAfter } from "./schedule";

export interface ViewDeps {
  store: RoutineStore;
  now: () => number;
}

/** How many runs a line of the list carries, and how many a routine's own page does. */
const LISTED_RUNS = 14;
const DETAILED_RUNS = 30;

export const listingOf = (run: RunRecord): RunListing => ({
  id: run.id,
  routineId: run.routineId,
  startedBy: run.startedBy,
  status: run.status,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  title: run.title,
  sessionId: run.sessionId,
});

export function infoOf(deps: ViewDeps, routine: RoutineRecord): RoutineInfo {
  const { store } = deps;
  const unseen = store.unseen(routine.id);
  return {
    id: routine.id,
    name: routine.name,
    conversationId: routine.conversationId,
    model: routine.model,
    schedule: routine.schedule,
    timezone: routine.timezone,
    enabled: routine.enabled,
    nextRunAt: routine.enabled ? nextRunOf(deps, routine) : null,
    revising: store.pendingFeedback(routine.id).length > 0,
    unseenReports: unseen.reports,
    unseenFailures: unseen.failures,
    createdAt: routine.createdAt,
    updatedAt: routine.updatedAt,
  };
}

export function summaryOf(
  deps: ViewDeps,
  routine: RoutineRecord,
): RoutineSummary {
  return {
    ...infoOf(deps, routine),
    runs: deps.store.runs(routine.id, LISTED_RUNS).map(listingOf),
  };
}

export const feedbackViewOf = (feedback: FeedbackRecord): FeedbackView => ({
  id: feedback.id,
  runId: feedback.runId,
  text: feedback.text,
  createdAt: feedback.createdAt,
  briefVersion: feedback.briefVersion,
  revisionFailed: feedback.revisionFailed,
});

export function runsOf(deps: ViewDeps, routineId: string): RunView[] {
  return deps.store.runs(routineId, DETAILED_RUNS).map((run) => ({
    ...listingOf(run),
    report: run.report,
    handoff: run.handoff,
    error: run.error,
    seenAt: run.seenAt,
    feedback: deps.store.feedbackOn(run.id).map(feedbackViewOf),
  }));
}

export function briefViewOf(deps: ViewDeps, brief: BriefRecord): BriefView {
  return {
    version: brief.version,
    text: brief.text,
    createdAt: brief.createdAt,
    feedback:
      brief.feedbackId === null
        ? null
        : (deps.store.feedback(brief.feedbackId)?.text ?? null),
  };
}

export function briefsOf(deps: ViewDeps, routineId: string): BriefView[] {
  return deps.store.briefs(routineId).map((brief) => briefViewOf(deps, brief));
}

export function handoffOf(
  deps: ViewDeps,
  routineId: string,
): HandoffView | null {
  return deps.store.handoff(routineId) ?? null;
}

/** When the clock runs the routine next; null when its schedule has no further time. */
function nextRunOf(deps: ViewDeps, routine: RoutineRecord): number | null {
  try {
    return nextRunAfter(routine.schedule, routine.timezone, deps.now()) ?? null;
  } catch {
    // A zone this runtime no longer knows: there is no next time to promise.
    return null;
  }
}
