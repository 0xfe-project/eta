import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { chatQueryOptions } from "@/queries/chat";
import { useGroupActions } from "@/queries/groups";
import { useOpenGroup } from "./use-groups";
import { useWorkspaceStore } from "./workspace-store";

/** Agents plus the locally remembered current one (newest by default). */
export function useAgents() {
  const { data, error, refetch } = useQuery(chatQueryOptions());
  const selectedAgentId = useWorkspaceStore((s) => s.workspace.selectedAgentId);
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace);
  const setAgentEditor = useWorkspaceStore((s) => s.setAgentEditor);
  const agents = data?.agents ?? [];
  const current =
    agents.find((agent) => agent.id === selectedAgentId) ?? agents.at(-1);
  return {
    agents,
    current,
    loaded: data !== undefined,
    /** Why they could not be loaded; `retry` asks again. */
    error,
    retry: () => void refetch(),
    select: (id: string) =>
      setWorkspace((state) => ({ ...state, selectedAgentId: id })),
    /** Edit an agent, or create one when called without an id. */
    openEditor: (agentId: string | null = null) =>
      setAgentEditor({ open: true, agentId }),
  };
}

/**
 * Open an agent's own conversation, from anywhere (on mobile, to the chat panel).
 *
 * "Talk to this agent" is a direct chat, and a direct chat may not exist yet — an agent made a
 * minute ago has none, and an agent that only ever worked inside groups has never needed one. So
 * this asks the host for it: the route creates it when missing and returns the same one when it
 * is already there, which is what makes pressing the button twice harmless.
 */
export function useOpenAgent() {
  const { select } = useAgents();
  const openGroup = useOpenGroup();
  const { direct } = useGroupActions();
  return (agentId: string) => {
    select(agentId);
    direct.mutate(agentId, {
      onSuccess: (group) => openGroup(group.id),
      onError: (error: Error) => toast.error(error.message),
    });
  };
}
