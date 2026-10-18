import type {
  BriefView,
  RoutineArgs,
  RoutineInfo,
  RoutineResults,
  RoutineSchedule,
  RoutineSections,
  RoutineSummary,
  RunListing,
  RunStatus,
  RunView,
} from "@eta/client-contracts";
import { useMemo } from "react";
import { useListTarget, useTarget, useWireMutation } from "@/queries/wire";

// Routines on the wire: the `routines` target (an eager `list`, each routine with its latest runs)
// and one `routines.<id>` target per routine (`info`, `briefs`, `runs` in full, `handoff`).
// Nothing polls: a run that ends, a brief being revised and the clock's next time arrive as state.

export type {
  RunListing as ListedRun,
  RoutineSummary,
  RunView as Run,
  RunStatus,
  RoutineSchedule as Schedule,
};
export type BriefVersion = BriefView;
/** A routine with everything its own page shows. */
export type Routine = RoutineInfo & Omit<RoutineSections, "info">;

export function useRoutines() {
  const { items, loaded, error } = useListTarget<RoutineSummary>("routines");
  return { routines: items, loaded, error };
}

/** A routine's page. `missing`: the eager list has loaded and has no such routine. */
export function useRoutine(id: string | null) {
  const { routines, loaded, error } = useRoutines();
  const state = useTarget(id === null ? undefined : `routines.${id}`);
  const info = state?.sections.info as RoutineInfo | undefined;
  const briefs = state?.sections.briefs as BriefView[] | undefined;
  const runs = state?.sections.runs as RunView[] | undefined;
  const handoff = state?.sections.handoff as Routine["handoff"] | undefined;
  const routine = useMemo<Routine | undefined>(
    () =>
      info === undefined || briefs === undefined || runs === undefined
        ? undefined
        : { ...info, briefs, runs, handoff: handoff ?? null },
    [info, briefs, runs, handoff],
  );
  return {
    routine,
    missing:
      id !== null &&
      routine === undefined &&
      loaded &&
      !routines.some((item) => item.id === id),
    error,
  };
}

/**
 * Records that the user saw the routine's finished runs (they opened it): its new reports and
 * failures stop waiting for them.
 */
export function useMarkRoutineSeen() {
  return useWireMutation<RoutineArgs["seen"], RoutineResults["seen"]>(
    "routines",
    "seen",
  );
}

export function useCreateRoutine() {
  return useWireMutation<RoutineArgs["create"], RoutineResults["create"]>(
    "routines",
    "create",
  );
}

/** Edits a routine, pauses it, or resumes it: whatever fields the call carries. */
export function useUpdateRoutine() {
  return useWireMutation<RoutineArgs["update"], RoutineResults["update"]>(
    "routines",
    "update",
  );
}

export function useDeleteRoutine() {
  return useWireMutation<RoutineArgs["delete"], RoutineResults["delete"]>(
    "routines",
    "delete",
  );
}

export function useRunRoutineNow() {
  return useWireMutation<RoutineArgs["run"], RoutineResults["run"]>(
    "routines",
    "run",
  );
}

export function useRestoreBrief() {
  return useWireMutation<
    RoutineArgs["restoreBrief"],
    RoutineResults["restoreBrief"]
  >("routines", "restoreBrief");
}

export function useSendFeedback() {
  return useWireMutation<RoutineArgs["feedback"], RoutineResults["feedback"]>(
    "routines",
    "feedback",
  );
}
