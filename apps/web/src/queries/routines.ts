import type {
  Brief,
  CronSchedule,
  DailySchedule,
  HourlySchedule,
  Routine,
  RoutineIn,
  Run,
  WeeklySchedule,
} from "@/api/routines.gen";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { routinesApi, unwrap } from "@/lib/api";

// Routines (#23): agents that run on a schedule and leave a report
// (/api/routines/v1; apps/routine-service). Every type comes from the routine
// service's OpenAPI document.

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
    (await unwrap(routinesApi.GET("/api/routines/v1/routines", { signal })))
      .routines,
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
        routinesApi.PATCH("/api/routines/v1/routines/{routine_id}", {
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
            routinesApi.PATCH("/api/routines/v1/routines/{routine_id}", {
              params: { path: { routine_id: id } },
              body: input,
            }),
          )
        : await unwrap(
            routinesApi.POST("/api/routines/v1/routines", { body: input }),
          )
      ).id,
  );
}

export function useDeleteRoutine() {
  return useRoutineMutation((id: string) =>
    unwrap(
      routinesApi.DELETE("/api/routines/v1/routines/{routine_id}", {
        params: { path: { routine_id: id } },
      }),
    ),
  );
}

export function useRunRoutineNow() {
  return useRoutineMutation((id: string) =>
    unwrap(
      routinesApi.POST("/api/routines/v1/routines/{routine_id}/run", {
        params: { path: { routine_id: id } },
      }),
    ),
  );
}

export function useRestoreBrief() {
  return useRoutineMutation(
    ({ id, version }: { id: string; version: number }) =>
      unwrap(
        routinesApi.POST(
          "/api/routines/v1/routines/{routine_id}/briefs/{version}/restore",
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
        routinesApi.POST(
          "/api/routines/v1/routines/{routine_id}/runs/{run_id}/feedback",
          {
            params: { path: { routine_id: id, run_id: runId } },
            body: { text },
          },
        ),
      ),
  );
}
