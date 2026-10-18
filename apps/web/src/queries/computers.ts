import type {
  Computer,
  ComputerRuntime,
  Computers,
} from "@/api/control-plane.gen";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { controlPlane, unwrap } from "@/lib/api";

// The user's remote computers (/api/v1/computers; apps/control-plane internal/tasks). Still the
// old REST API: the machines step moves them to the `machines` target, and this file goes then.

export type { Computer, ComputerRuntime };

const key = ["computers"] as const;

export function useComputers() {
  return useQuery({
    queryKey: key,
    queryFn: async ({ signal }): Promise<Computers> =>
      unwrap(controlPlane.GET("/api/v1/computers", { signal })),
    // Pairings and connections change on the computers' side.
    refetchInterval: 4000,
  });
}

function useComputerMutation<T, R>(call: (input: T) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
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

/** How many runs the computer works on at once; the next dispatch reads it. */
export function useSetComputerLimit() {
  return useComputerMutation(
    ({ id, maxActiveRuns }: { id: string; maxActiveRuns: number }) =>
      unwrap(
        controlPlane.PUT("/api/v1/computers/{computer_id}/limit", {
          params: { path: { computer_id: id } },
          body: { max_active_runs: maxActiveRuns },
        }),
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

const runtimeLabels: Record<string, string> = {
  paseo: "Paseo",
  herdr: "Herdr",
};
const providerLabels: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  devin: "Devin",
};

export const runtimeLabel = (runtime: string) =>
  runtimeLabels[runtime] ?? runtime;
export const providerLabel = (provider: string) =>
  providerLabels[provider] ?? provider;
