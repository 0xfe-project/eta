import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";

// Routines (#23): agents that run on a schedule, each run in a fresh runtime,
// and leave a report (/api/v1/routines; apps/control-plane/routines).

export type Schedule =
  | { kind: "daily"; time: string }
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "hourly"; every: number }
  | { kind: "cron"; cron: string };

export type RunStatus = "running" | "sent" | "nothing_new" | "failed";

interface Feedback {
  id: string;
  text: string;
  created_at: string;
  // The brief version it led to; null while the revision runs.
  brief_version: number | null;
  revision_failed: boolean;
}

export interface Run {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  // The report's first heading, if it sent one.
  title: string | null;
  report: string | null;
  error: string | null;
  feedback: Feedback[];
}

export interface BriefVersion {
  version: number;
  text: string;
  created_at: string;
  // The feedback that revised it; null when the user wrote it.
  feedback: string | null;
}

export interface Routine {
  id: string;
  name: string;
  model: string;
  schedule: Schedule;
  timezone: string;
  enabled: boolean;
  next_run_at: string | null;
  briefs: BriefVersion[];
  handoff: { text: string; written_at: string } | null;
  runs: Run[];
}

export interface RoutineInput {
  name: string;
  brief: string;
  model: string;
  schedule: Schedule;
  timezone: string;
}

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
    ((await apiGet("/routines", signal)) as { routines: Routine[] }).routines,
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

const path = (id: string) => `/routines/${encodeURIComponent(id)}`;

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
      apiPatch(path(id), { enabled }),
  );
}

/** Creates (id null) or edits a routine; resolves to its id. */
export function useSaveRoutine() {
  return useRoutineMutation(
    async ({ id, input }: { id: string | null; input: RoutineInput }) =>
      (
        (id
          ? await apiPatch(path(id), input)
          : await apiPost("/routines", input)) as Routine
      ).id,
  );
}

export function useDeleteRoutine() {
  return useRoutineMutation((id: string) => apiDelete(path(id)));
}

export function useRunRoutineNow() {
  return useRoutineMutation((id: string) => apiPost(`${path(id)}/run`));
}

export function useRestoreBrief() {
  return useRoutineMutation(
    ({ id, version }: { id: string; version: number }) =>
      apiPost(`${path(id)}/briefs/${version}/restore`),
  );
}

export function useSendFeedback() {
  return useRoutineMutation(
    ({ id, runId, text }: { id: string; runId: string; text: string }) =>
      apiPost(`${path(id)}/runs/${encodeURIComponent(runId)}/feedback`, {
        text,
      }),
  );
}
