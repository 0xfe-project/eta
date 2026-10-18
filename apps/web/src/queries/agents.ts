import type { AgentArgs, AgentResults, AgentView } from "@eta/client-contracts";
import { translate } from "@/lib/i18n";
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
