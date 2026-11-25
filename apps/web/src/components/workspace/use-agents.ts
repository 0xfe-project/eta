import { toast } from "sonner";
import { useAgentList } from "@/queries/agents";
import {
  useConversationList,
  useCreateConversation,
} from "@/queries/conversations";
import { ownChatOf } from "./use-chat-list";
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
 * The create of one agent's chat that is already on its way, by agent id. The host does not
 * deduplicate `conversations.create` and the list only says what exists once it has been answered,
 * so two presses in one breath would otherwise make two conversations.
 */
const creating = new Map<string, Promise<string>>();

/**
 * Open an agent's own conversation, from anywhere (on mobile, to the chat panel).
 *
 * "Talk to this agent" is the group of one in its home project: found when it is already there,
 * made the first time it is asked for. `agents.direct` no longer exists on the host, so the client
 * is what remembers that an agent has one chat and not a new one per press.
 */
export function useOpenAgent() {
  const { select, agents } = useAgents();
  const openGroup = useOpenGroup();
  const { conversations } = useConversationList();
  const { mutateAsync } = useCreateConversation();
  return (agentId: string) => {
    select(agentId);
    const agent = agents.find((each) => each.id === agentId);
    // An agent that is gone from the list cannot have a chat opened: the row that called this was
    // drawn from a list that has since moved on.
    if (agent === undefined) return;
    const chat = ownChatOf(agent, conversations);
    // A chat that is put away is not the one this opens: it stays in the archive and the agent gets
    // a new one, as it did when the host kept its chats itself.
    if (chat !== undefined && !chat.archived) {
      openGroup(chat.id);
      return;
    }
    const wait =
      creating.get(agent.id) ??
      mutateAsync({
        projectId: agent.homeProjectId,
        agentIds: [agent.id],
        stewardId: agent.id,
      }).then(({ conversation }) => conversation.id);
    if (!creating.has(agent.id)) {
      creating.set(agent.id, wait);
      // Whatever it comes to, the next press asks again rather than waiting on a settled promise.
      const forget = () => creating.delete(agent.id);
      void wait.then(forget, forget);
    }
    void wait.then(openGroup, (error: Error) => toast.error(error.message));
  };
}
