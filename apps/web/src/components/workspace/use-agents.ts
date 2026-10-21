import { toast } from "sonner";
import { useAgentList, useDirectChat } from "@/queries/agents";
import { useOpenGroup } from "./use-groups";
import { useWorkspaceStore } from "./workspace-store";

/** Agents plus the locally remembered current one (the first by default). */
export function useAgents() {
  const { agents, loaded, error } = useAgentList();
  const selectedAgentId = useWorkspaceStore((s) => s.workspace.selectedAgentId);
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace);
  const setAgentEditor = useWorkspaceStore((s) => s.setAgentEditor);
  // Nothing selected, or a selection whose agent is gone: open the first one.
  const current =
    agents.find((agent) => agent.id === selectedAgentId) ?? agents[0];
  return {
    agents,
    current,
    loaded,
    /** Why they cannot be loaded: the host does not serve them. */
    error,
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
 * "Talk to this agent" is its private chat, which the host makes the first time it is asked for
 * and finds every time after: pressing the button twice opens the same conversation.
 */
export function useOpenAgent() {
  const { select } = useAgents();
  const openGroup = useOpenGroup();
  const { mutate } = useDirectChat();
  return (agentId: string) => {
    select(agentId);
    mutate(
      { agentId },
      {
        onSuccess: ({ conversation }) => openGroup(conversation.id),
        onError: (error: Error) => toast.error(error.message),
      },
    );
  };
}
