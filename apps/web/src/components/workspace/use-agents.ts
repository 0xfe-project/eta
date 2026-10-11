import { useLocation, useNavigate } from "@tanstack/react-router";
import { useChatSnapshot } from "@/queries/chat";
import { useWorkspaceStore } from "./workspace-store";

/** Agents plus the locally remembered current one (newest by default). */
export function useAgents() {
  const { data, error, refetch } = useChatSnapshot();
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

/** Switch to an agent's chat, from any page (on mobile, to the chat panel). */
export function useOpenAgent() {
  const { select } = useAgents();
  const setMobilePanel = useWorkspaceStore((s) => s.setMobilePanel);
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  return (agentId: string) => {
    select(agentId);
    setMobilePanel("chat");
    if (pathname !== "/") void navigate({ to: "/" });
  };
}
