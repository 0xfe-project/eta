import type {
  Brief,
  CronSchedule,
  DailySchedule,
  HourlySchedule,
  Routine,
  RoutineIn,
  Run,
  WeeklySchedule,
} from "@/api/control-plane.gen";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { controlPlane, unwrap } from "@/lib/api";

// Routines (#23): agents that run on a schedule, each run in a fresh runtime,
// and leave a report (/api/v1/routines; apps/control-plane). Every type comes
// from the control plane's OpenAPI document.

export type { Routine, Run };
export type Schedule =
  | DailySchedule
  | WeeklySchedule
  | HourlySchedule
  | CronSchedule;
export type RunStatus = Run["status"];
export type BriefVersion = Brief;
export type RoutineInput = RoutineIn;

const keys = { all: ["routines"] as const };

// Faster while something is happening: a run, or a brief being revised.
function busy(routines: Routine[] | undefined) {
  return (routines ?? []).some((routine) =>
    routine.runs.some(
      (run) =>
        run.status === "running" ||
        run.feedback.some(
          (f) => f.brief_version === null && !f.revision_failed,
        ),
    ),
  );
}

const routinesQueryOptions = queryOptions({
  queryKey: keys.all,
  queryFn: async ({ signal }) =>
    (await unwrap(controlPlane.GET("/api/v1/routines", { signal }))).routines,
  refetchInterval: (query) => (busy(query.state.data) ? 3000 : 30_000),
});

export function useRoutines() {
  return useQuery(routinesQueryOptions);
}

export function useRoutine(id: string | null) {
  return useQuery({
    ...routinesQueryOptions,
    select: (routines) => routines.find((routine) => routine.id === id),
    enabled: Boolean(id),
  });
}

function useRoutineMutation<T, R = unknown>(call: (input: T) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.all }),
  });
}

export function useSetRoutineEnabled() {
  return useRoutineMutation(
    ({ id, enabled }: { id: string; enabled: boolean }) =>
      unwrap(
        controlPlane.PATCH("/api/v1/routines/{routine_id}", {
          params: { path: { routine_id: id } },
          body: { enabled },
        }),
      ),
  );
}

/** Creates (id null) or edits a routine; resolves to its id. */
export function useSaveRoutine() {
  return useRoutineMutation(
    async ({ id, input }: { id: string | null; input: RoutineInput }) =>
      (id
        ? await unwrap(
            controlPlane.PATCH("/api/v1/routines/{routine_id}", {
              params: { path: { routine_id: id } },
              body: input,
            }),
          )
        : await unwrap(controlPlane.POST("/api/v1/routines", { body: input }))
      ).id,
  );
}

export function useDeleteRoutine() {
  return useRoutineMutation((id: string) =>
    unwrap(
      controlPlane.DELETE("/api/v1/routines/{routine_id}", {
        params: { path: { routine_id: id } },
      }),
    ),
  );
}

export function useRunRoutineNow() {
  return useRoutineMutation((id: string) =>
    unwrap(
      controlPlane.POST("/api/v1/routines/{routine_id}/run", {
        params: { path: { routine_id: id } },
      }),
    ),
  );
}

export function useRestoreBrief() {
  return useRoutineMutation(
    ({ id, version }: { id: string; version: number }) =>
      unwrap(
        controlPlane.POST(
          "/api/v1/routines/{routine_id}/briefs/{version}/restore",
          {
            params: { path: { routine_id: id, version } },
          },
        ),
      ),
  );
}

export function useSendFeedback() {
  return useRoutineMutation(
    ({ id, runId, text }: { id: string; runId: string; text: string }) =>
      unwrap(
        controlPlane.POST(
          "/api/v1/routines/{routine_id}/runs/{run_id}/feedback",
          {
            params: { path: { routine_id: id, run_id: runId } },
            body: { text },
          },
        ),
      ),
  );
}
