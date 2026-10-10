import type {
  Brief,
  CronSchedule,
  DailySchedule,
  HourlySchedule,
  ListedRun,
  Routine,
  RoutineIn,
  RoutineSummary,
  Run,
  WeeklySchedule,
} from "@/api/routines.gen";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ApiError, routinesApi, unwrap } from "@/lib/api";

// Routines (#23): agents that run on a schedule and leave a report
// (/api/routines/v1; apps/routine-service). Every type comes from the routine
// service's OpenAPI document. The list is in summary (no reports, no
// briefs); a routine's page is fetched when it is opened.

export type { ListedRun, Routine, RoutineSummary, Run };
export type Schedule =
  | DailySchedule
  | WeeklySchedule
  | HourlySchedule
  | CronSchedule;
export type RunStatus = Run["status"];
export type BriefVersion = Brief;
export type RoutineInput = RoutineIn;

const keys = {
  all: ["routines"] as const,
  one: (id: string) => ["routines", id] as const,
};

// Faster while something is happening: a run, or a brief being revised.
const POLL_BUSY = 3000;
const POLL_IDLE = 30_000;

const routinesQueryOptions = queryOptions({
  queryKey: keys.all,
  queryFn: async ({ signal }) =>
    (await unwrap(routinesApi.GET("/api/routines/v1/routines", { signal })))
      .routines,
  refetchInterval: (query) =>
    (query.state.data ?? []).some(
      (routine) => routine.runs[0]?.status === "running" || routine.revising,
    )
      ? POLL_BUSY
      : POLL_IDLE,
});

export function useRoutines() {
  return useQuery(routinesQueryOptions);
}

/** A routine's page; null once it is gone. */
export function useRoutine(id: string | null) {
  return useQuery({
    queryKey: keys.one(id ?? ""),
    queryFn: async ({ signal }) => {
      try {
        return await unwrap(
          routinesApi.GET("/api/routines/v1/routines/{routine_id}", {
            params: { path: { routine_id: id! } },
            signal,
          }),
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const routine = query.state.data;
      const busy =
        routine?.runs[0]?.status === "running" ||
        routine?.runs.some((run) =>
          run.feedback.some(
            (f) => f.brief_version === null && !f.revision_failed,
          ),
        );
      return busy ? POLL_BUSY : POLL_IDLE;
    },
  });
}

function useRoutineMutation<T, R = unknown>(call: (input: T) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.all }),
  });
}

/**
 * Records that the user saw the routine's finished runs (they opened it):
 * its new reports and failures stop waiting for them.
 */
export function useMarkRoutineSeen() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        routinesApi.POST("/api/routines/v1/routines/{routine_id}/seen", {
          params: { path: { routine_id: id } },
        }),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: keys.all, exact: true }),
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
