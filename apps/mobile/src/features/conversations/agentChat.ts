import type { AgentView, ConversationResults } from "@eta/client-contracts";
import { call } from "../../wire/target";

/**
 * A chat with one agent is a group of its own in the agent's home project, with the agent as its
 * only member and its steward. Resolves to the new conversation's id; the host's refusal rejects.
 */
export async function makeAgentChat(agent: AgentView): Promise<string> {
  const { conversation } = await call<ConversationResults["create"]>(
    "conversations",
    "create",
    {
      projectId: agent.homeProjectId,
      agentIds: [agent.id],
      stewardId: agent.id,
    },
  );
  return conversation.id;
}
