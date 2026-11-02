import type {
  AgentArgs,
  AgentResults,
  AgentRuntime,
  AgentRuntimeInfo,
  AgentView,
} from "@eta/client-contracts";
import type { Model } from "@/queries/providers";
import { useQuery } from "@tanstack/react-query";
import { translate } from "@/lib/i18n";
import { getWire } from "@/lib/wire";
import { useMachines } from "@/queries/projects";
import { useModels } from "@/queries/providers";
import { useListTarget, useWireMutation } from "@/queries/wire";

// Agents on the wire: the `agents` target (one eager `list` section) and its four actions. An
// agent is a configuration, not a container; its workspace is a project of its own and its private
// chat is the conversation `direct` returns.

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

/** The private chat with an agent: made the first time, found every time after. */
export function useDirectChat() {
  return useWireMutation<AgentArgs["direct"], AgentResults["direct"]>(
    "agents",
    "direct",
  );
}

/**
 * The external runtimes a machine has (Claude Code, Codex, ...), with their models: the host's own
 * when no machine is named. Asking can start a runtime to list its models, so the answer is kept
 * for a while; the host keeps its own.
 */
function useAgentRuntimes(machineId: string | undefined) {
  return useQuery({
    queryKey: ["wire", "agents", "runtimes", machineId ?? ""],
    queryFn: async () =>
      (
        await getWire().call<AgentResults["runtimes"]>(
          "agents",
          "runtimes",
          machineId === undefined ? {} : { machineId },
        )
      ).runtimes,
    staleTime: 5 * 60_000,
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
    default: model.default,
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
  runtime: AgentRuntime,
  machineId: string,
): {
  runtimes: AgentRuntimeInfo[] | null | undefined;
  models: Model[] | null | undefined;
} {
  const { machines } = useMachines();
  const { data: providerModels } = useModels();
  const primary = machines.find((machine) => machine.kind === "primary");
  const { data, isError } = useAgentRuntimes(
    machineId === "" || machineId === primary?.id ? undefined : machineId,
  );
  // A refetch that fails keeps the list it had: only a machine that never answered is unknown.
  const runtimes = data ?? (isError ? null : undefined);
  if (runtime === "eta") return { runtimes, models: providerModels };
  // An external runtime's models come with the machine's list: loading or unknown with it.
  if (!runtimes) return { runtimes, models: runtimes };
  const info = runtimes.find((entry) => entry.id === runtime);
  return { runtimes, models: info === undefined ? [] : runtimeModelsOf(info) };
}
