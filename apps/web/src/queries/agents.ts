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
 * The external runtimes the host's machine has (Claude Code, Codex, ...), with their models. Asking
 * can start a runtime to list its models, so the answer is kept for a while; the host keeps its own.
 */
export function useAgentRuntimes() {
  return useQuery({
    queryKey: ["wire", "agents", "runtimes"],
    queryFn: async () =>
      (await getWire().call<AgentResults["runtimes"]>("agents", "runtimes", {}))
        .runtimes,
    staleTime: 5 * 60_000,
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
 * The models an agent on `runtime` can choose: eta's providers' on eta, the runtime's own on an
 * external one. Undefined while they load.
 */
export function useAgentModels(runtime: AgentRuntime): Model[] | undefined {
  const { data: models } = useModels();
  const { data: runtimes } = useAgentRuntimes();
  if (runtime === "eta") return models;
  if (runtimes === undefined) return undefined;
  const info = runtimes.find((entry) => entry.id === runtime);
  return info === undefined ? [] : runtimeModelsOf(info);
}
