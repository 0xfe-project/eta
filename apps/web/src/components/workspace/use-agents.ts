import { useQuery } from "@tanstack/react-query";
import { chatQueryOptions } from "@/queries/chat";
import { useWorkspace } from "./workspace-state";

/** Agents plus the locally remembered current one (newest by default). */
export function useAgents() {
  const { data } = useQuery(chatQueryOptions());
  const { workspace, setWorkspace } = useWorkspace();
  const agents = data?.agents ?? [];
  const current =
    agents.find((agent) => agent.id === workspace.selectedAgentId) ??
    agents.at(-1);
  const select = (id: string) =>
    setWorkspace((state) => ({ ...state, selectedAgentId: id }));
  return { agents, current, select, loaded: data !== undefined };
}
