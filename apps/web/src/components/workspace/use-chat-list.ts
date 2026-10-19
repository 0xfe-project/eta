import type { AgentView, ConversationSummary } from "@eta/client-contracts";
import { useMemo } from "react";
import { useAgentList } from "@/queries/agents";
import { useGroups } from "./use-groups";

/** One row of the list of everything you can chat with. */
export type ChatRow =
  | { kind: "conversation"; conversation: ConversationSummary }
  | { kind: "agent"; agent: AgentView };

/**
 * Everything you can chat with, as one list: each open group chat and direct chat, then the
 * agents that have no direct chat yet (pressing one makes it).
 *
 * Conversations come newest activity first. Agents without a chat have no activity, so they go
 * after, in the order they were created. An agent with a chat shows up once, as that chat.
 */
export function useChatList() {
  const { groups, current } = useGroups();
  const { agents, loaded } = useAgentList();
  const rows = useMemo<ChatRow[]>(() => {
    const open = groups.filter((conversation) => !conversation.archived);
    // Every agent a private chat exists for, archived or not. Counting only the open ones made
    // archiving a chat put its agent back in the list as an agent with no chat — the row the
    // person had just archived, under the same name.
    const talked = new Set(
      groups
        .filter((conversation) => conversation.kind === "direct")
        .map((conversation) => conversation.participants[0]?.agentId),
    );
    return [
      ...open.map((conversation) => ({
        kind: "conversation" as const,
        conversation,
      })),
      ...[...agents]
        .filter((agent) => !talked.has(agent.id))
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((agent) => ({ kind: "agent" as const, agent })),
    ];
  }, [groups, agents]);
  return { rows, current, loaded };
}
