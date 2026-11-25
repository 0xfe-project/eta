import type {
  AgentArgs,
  AgentResults,
  AgentRuntimeAccount,
  AgentRuntimeInfo,
  AgentView,
  MachineView,
} from "@eta/client-contracts";
import type { Model } from "@/queries/providers";
import {
  queryOptions,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { translate } from "@/lib/i18n";
import { declaredLevels } from "@/lib/thinking";
import { getWire } from "@/lib/wire";
import { useMachines } from "@/queries/projects";
import { useModels } from "@/queries/providers";
import { useListTarget, useWireMutation } from "@/queries/wire";

// Agents on the wire: the `agents` target (one eager `list` section) and its three actions. An
// agent is a configuration, not a container; its workspace is a project of its own and its own chat
// is a group of one in that project (see `useOpenAgent`: there is no `agents.direct` any more).

/** Every agent, newest last (the order the host keeps them in). */
export function useAgentList() {
  const { items, loaded, error } = useListTarget<AgentView>("agents");
  return { agents: items, loaded, error };
}

/** What an agent is called; an agent that has been deleted since says so. */
export function agentName(
  agents: readonly Pick<AgentView, "id" | "name">[],
  agentId: string | null | undefined,
): string {
  return (
    agents.find((agent) => agent.id === agentId)?.name ??
    translate("agents:labels.deletedAgent")
  );
}

export function useCreateAgent() {
  return useWireMutation<AgentArgs["create"], AgentResults["create"]>(
    "agents",
    "create",
  );
}

export function useUpdateAgent() {
  return useWireMutation<AgentArgs["update"], AgentResults["update"]>(
    "agents",
    "update",
  );
}

export function useDeleteAgent() {
  return useWireMutation<AgentArgs["delete"], AgentResults["delete"]>(
    "agents",
    "delete",
  );
}

/**
 * The external runtimes a machine has (Claude Code, Codex, ...), with their models: the host's own
 * when no machine is named. Asking can start a runtime to list its models, so the answer is kept
 * for a while; the host keeps its own.
 */
const runtimesQuery = (machineId: string | undefined) =>
  queryOptions({
    queryKey: ["wire", "agents", "runtimes", machineId ?? ""],
    queryFn: async () =>
      (
        await getWire().call<AgentResults["runtimes"]>(
          "agents",
          "runtimes",
          machineId === undefined ? {} : { machineId },
          // Past a runtime's own 30s, so a probe that times out is told as one, not as a lost machine.
          { timeoutMs: 70_000 },
        )
      ).runtimes,
    staleTime: 5 * 60_000,
    retry: false,
  });

// A refetch that fails keeps the list it had: only a machine that never answered is unknown.
const knownRuntimes = ({
  data,
  isError,
}: {
  data: AgentRuntimeInfo[] | undefined;
  isError: boolean;
}) => data ?? (isError ? null : undefined);

/**
 * What each of these machines has, by machine id, each undefined until it answers and null when it
 * could not be asked. They are asked one by one, so a slow machine holds up only its own answer.
 */
export function useRuntimesByMachine(
  machines: readonly MachineView[],
): ReadonlyMap<string, AgentRuntimeInfo[] | null | undefined> {
  const answers = useQueries({
    queries: machines.map((machine) =>
      runtimesQuery(machine.kind === "primary" ? undefined : machine.id),
    ),
  });
  return new Map(
    machines.map((machine, at) => [machine.id, knownRuntimes(answers[at]!)]),
  );
}

/**
 * Ask a machine's runtimes again (`machineId` undefined is the primary), past both caches: the
 * host keeps a failed answer as long as a good one, so only `fresh` gets a new look. The answer
 * replaces the machine's list for every reader of it.
 */
export function useRefreshRuntimes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (machineId: string | undefined) =>
      (
        await getWire().call<AgentResults["runtimes"]>(
          "agents",
          "runtimes",
          machineId === undefined
            ? { fresh: true }
            : { fresh: true, machineId },
          // Each runtime may take its full 30s to list its models, and a daemon is asked over its link.
          { timeoutMs: 70_000 },
        )
      ).runtimes,
    onSuccess: (runtimes, machineId) =>
      queryClient.setQueryData(runtimesQuery(machineId).queryKey, runtimes),
  });
}

/**
 * A built-in runtime's sign-in and plan usage on a machine (`machineId` undefined is the primary),
 * as the runtime reports them; asked only while `enabled` (a detail that is open).
 */
export function useRuntimeAccount(
  runtime: string,
  machineId: string | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["wire", "agents", "runtimeAccount", machineId ?? "", runtime],
    queryFn: async (): Promise<AgentRuntimeAccount> =>
      (
        await getWire().call<AgentResults["runtimeAccount"]>(
          "agents",
          "runtimeAccount",
          machineId === undefined ? { runtime } : { runtime, machineId },
          // The sign-in and the usage each have the runtime's 30s, and a daemon is asked over its link.
          { timeoutMs: 70_000 },
        )
      ).account,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** A runtime's models as a picker lists them: `runtime:modelId`, under the runtime's name. */
function runtimeModelsOf(info: AgentRuntimeInfo): Model[] {
  return info.models.map((model) => ({
    id: `${info.id}:${model.id}`,
    provider: info.id,
    providerName: info.label,
    name: model.name,
    available: info.status === "available",
    thinking: declaredLevels({ efforts: model.efforts }),
  }));
}

/**
 * What an agent form offers on the machine it names ("" follows the project): that machine's
 * runtimes, and the models an agent on `runtime` can choose (eta's providers' on eta, the
 * runtime's own on an external one).
 *
 * Each is undefined while it loads and null when the machine could not be asked (offline, or no
 * link): then nothing is known about it, which is not the same as having none. The host answers
 * for the primary itself whether it is named or not, so naming it asks nothing new.
 */
export function useAgentRuntimeChoices(
  runtime: string,
  machineId: string,
): {
  runtimes: AgentRuntimeInfo[] | null | undefined;
  models: Model[] | null | undefined;
  /** Ask the machine's runtimes again. */
  refresh: { run: () => void; pending: boolean; error: Error | null };
} {
  const { machines } = useMachines();
  const { data: providerModels } = useModels();
  const primary = machines.find((machine) => machine.kind === "primary");
  const asked =
    machineId === "" || machineId === primary?.id ? undefined : machineId;
  const runtimes = knownRuntimes(useQuery(runtimesQuery(asked)));
  const again = useRefreshRuntimes();
  const refresh = {
    run: () => again.mutate(asked),
    pending: again.isPending,
    error: again.error,
  };
  if (runtime === "eta") return { runtimes, models: providerModels, refresh };
  // An external runtime's models come with the machine's list: loading or unknown with it.
  if (!runtimes) return { runtimes, models: runtimes, refresh };
  const info = runtimes.find((entry) => entry.id === runtime);
  return {
    runtimes,
    models: info === undefined ? [] : runtimeModelsOf(info),
    refresh,
  };
}
