import type {
  AssigneeInput,
  AssigneeOption,
  Computer,
  ComputerRuntime,
  Computers,
  LogEntry,
  Place,
  Places,
  Task,
  TaskActivity,
  TaskDetail,
  TaskIn,
  TaskRun,
  TaskUpdateIn,
} from "@/api/control-plane.gen";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { controlPlane, unwrap } from "@/lib/api";

// The task board and the remote computers that work on it
// (/api/v1/tasks, /api/v1/computers; apps/control-plane internal/tasks).

export type {
  AssigneeInput,
  AssigneeOption,
  Computer,
  ComputerRuntime,
  LogEntry,
  Place,
  Places,
  Task,
  TaskActivity,
  TaskDetail,
  TaskRun,
};
export type TaskStatus = Task["status"];
export type RunStatus = TaskRun["status"];
export type TaskInput = TaskIn;

const keys = {
  tasks: ["tasks"] as const,
  task: (id: string) => ["tasks", id] as const,
  log: (task: string, run: string) => ["tasks", task, "log", run] as const,
  computers: ["computers"] as const,
  places: (computer: string, runtime: string) =>
    ["computers", computer, runtime, "places"] as const,
};

const activeRun = (status: string | null | undefined) =>
  status === "queued" || status === "starting" || status === "running";

export function useTasks() {
  return useQuery({
    queryKey: keys.tasks,
    queryFn: async ({ signal }) =>
      unwrap(controlPlane.GET("/api/v1/tasks", { signal })),
    // Remote agents comment and change status on their own.
    refetchInterval: (query) =>
      query.state.data?.tasks.some((t) => activeRun(t.run_status))
        ? 3000
        : 15_000,
  });
}

export function useTask(id: string | null) {
  return useQuery({
    queryKey: keys.task(id ?? ""),
    queryFn: async ({ signal }) =>
      unwrap(
        controlPlane.GET("/api/v1/tasks/{task_id}", {
          params: { path: { task_id: id! } },
          signal,
        }),
      ),
    enabled: Boolean(id),
    refetchInterval: (query) =>
      query.state.data?.runs.some((r) => activeRun(r.status)) ? 2000 : 10_000,
  });
}

/**
 * A run's transcript, read from the remote agent while it is open: the latest
 * page, then older ones on demand, oldest first.
 */
export function useRunLog(task: string, run: string, live: boolean) {
  const log = useInfiniteQuery({
    queryKey: keys.log(task, run),
    queryFn: async ({ pageParam, signal }) =>
      unwrap(
        controlPlane.GET("/api/v1/tasks/{task_id}/runs/{run_id}/log", {
          params: {
            path: { task_id: task, run_id: run },
            query: pageParam ? { before: pageParam } : {},
          },
          signal,
        }),
      ),
    initialPageParam: "",
    getNextPageParam: (page) => page.older || undefined,
    refetchInterval: live ? 3000 : false,
    retry: false,
  });
  const pages = log.data?.pages;
  const entries = useMemo(
    () => [...(pages ?? [])].reverse().flatMap((page) => page.entries),
    [pages],
  );
  return {
    entries,
    error: log.error,
    isPending: log.isPending,
    hasOlder: log.hasNextPage,
    loadingOlder: log.isFetchingNextPage,
    loadOlder: log.fetchNextPage,
  };
}

function useTaskMutation<T>(call: (input: T) => Promise<TaskDetail>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: (task) => queryClient.setQueryData(keys.task(task.id), task),
    // Not awaited: the answer, or the failure, is news before the board
    // has caught up with it.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.tasks });
    },
  });
}

export function useCreateTask() {
  return useTaskMutation((input: TaskInput) =>
    unwrap(controlPlane.POST("/api/v1/tasks", { body: input })),
  );
}

export function useUpdateTask() {
  return useTaskMutation(
    ({ id, changes }: { id: string; changes: TaskUpdateIn }) =>
      unwrap(
        controlPlane.PATCH("/api/v1/tasks/{task_id}", {
          params: { path: { task_id: id } },
          body: changes,
        }),
      ),
  );
}

/** `key` is the comment's Idempotency-Key: every try of one comment shares it. */
export function useCommentTask() {
  return useTaskMutation(
    ({ id, body, key }: { id: string; body: string; key: string }) =>
      unwrap(
        controlPlane.POST("/api/v1/tasks/{task_id}/comments", {
          params: {
            path: { task_id: id },
            header: { "Idempotency-Key": key },
          },
          body: { body },
        }),
      ),
  );
}

export function useInterruptRun() {
  return useTaskMutation(({ id, run }: { id: string; run: string }) =>
    unwrap(
      controlPlane.POST("/api/v1/tasks/{task_id}/runs/{run_id}/interrupt", {
        params: { path: { task_id: id, run_id: run } },
      }),
    ),
  );
}

export function useDeleteTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        controlPlane.DELETE("/api/v1/tasks/{task_id}", {
          params: { path: { task_id: id } },
        }),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.tasks }),
  });
}

// --- computers ---------------------------------------------------------------------

/** Where on a computer's runtime an agent can work, read from it now. */
export function usePlaces(computer: string | null, runtime: string | null) {
  return useQuery({
    queryKey: keys.places(computer ?? "", runtime ?? ""),
    queryFn: async ({ signal }): Promise<Places> =>
      unwrap(
        controlPlane.GET(
          "/api/v1/computers/{computer_id}/runtimes/{kind}/places",
          {
            params: {
              path: {
                computer_id: computer!,
                kind: runtime as "paseo" | "herdr",
              },
            },
            signal,
          },
        ),
      ),
    enabled: Boolean(computer && runtime),
    retry: false,
    staleTime: 10_000,
  });
}

export function useComputers() {
  return useQuery({
    queryKey: keys.computers,
    queryFn: async ({ signal }): Promise<Computers> =>
      unwrap(controlPlane.GET("/api/v1/computers", { signal })),
    // Pairings and connections change on the computers' side.
    refetchInterval: 4000,
  });
}

// An explicit read-only observation; never start an agent as a probe.
export function useCheckComputer() {
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        controlPlane.GET("/api/v1/computers/{computer_id}/check", {
          params: { path: { computer_id: id } },
        }),
      ),
  });
}

function useComputerMutation<T, R>(call: (input: T) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.computers });
      void queryClient.invalidateQueries({ queryKey: keys.tasks });
    },
  });
}

export function useAddComputer() {
  return useComputerMutation((name: string) =>
    unwrap(controlPlane.POST("/api/v1/computers", { body: { name } })),
  );
}

export function useRenewInstall() {
  return useComputerMutation((id: string) =>
    unwrap(
      controlPlane.POST("/api/v1/computers/{computer_id}/install", {
        params: { path: { computer_id: id } },
      }),
    ),
  );
}

/** Approves the pairing whose fingerprint the user compared, only that one. */
export function useApproveRuntime() {
  return useComputerMutation(
    ({
      id,
      kind,
      fingerprint,
    }: {
      id: string;
      kind: ComputerRuntime["kind"];
      fingerprint: string;
    }) =>
      unwrap(
        controlPlane.POST(
          "/api/v1/computers/{computer_id}/runtimes/{kind}/approve",
          {
            params: { path: { computer_id: id, kind } },
            body: { fingerprint },
          },
        ),
      ),
  );
}

export function useDeleteComputer() {
  return useComputerMutation((id: string) =>
    unwrap(
      controlPlane.DELETE("/api/v1/computers/{computer_id}", {
        params: { path: { computer_id: id } },
      }),
    ),
  );
}
