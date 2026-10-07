import { useQuery } from "@tanstack/react-query";
import { chatQueryOptions } from "@/queries/chat";
import { useWorkspace } from "./workspace-state";

/** Agents plus the locally remembered current one (newest by default). */
export function useAgents() {
  const { data } = useQuery(chatQueryOptions());
  const { workspace, setWorkspace, setAgentEditor } = useWorkspace();
  const agents = data?.agents ?? [];
  const current =
    agents.find((agent) => agent.id === workspace.selectedAgentId) ??
    agents.at(-1);
  return {
    agents,
    current,
    loaded: data !== undefined,
    select: (id: string) =>
      setWorkspace((state) => ({ ...state, selectedAgentId: id })),
    /** Edit an agent, or create one when called without an id. */
    openEditor: (agentId: string | null = null) =>
      setAgentEditor({ open: true, agentId }),
  };
}
