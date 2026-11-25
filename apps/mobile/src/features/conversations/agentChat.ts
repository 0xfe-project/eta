import type { AgentView, ConversationResults } from "@eta/client-contracts";
import { call } from "../../wire/target";
import { ownChatOf } from "./list";

/** The create of one agent's chat already on its way, by agent id: two presses make one group. */
const making = new Map<string, Promise<string>>();

async function create(agent: AgentView): Promise<string> {
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

/**
 * The chat with one agent: the group of one it already has in its home project, or a new one made
 * there with the agent as its only member and its steward. Resolves to the conversation's id; the
 * host's refusal rejects.
 *
 * The host has no `agents.direct` any more and `conversations.create` does not deduplicate, so
 * finding the chat is the client's job: pressing twice opens the same conversation.
 */
export async function makeAgentChat(agent: AgentView): Promise<string> {
  const known = ownChatOf(agent);
  // A chat that is put away is not the one this opens: a new one is made, and the archived one
  // stays in the archive where it was put.
  if (known !== undefined && !known.archived) return known.id;
  const waiting = making.get(agent.id);
  if (waiting !== undefined) return waiting;
  const made = create(agent);
  making.set(agent.id, made);
  const forget = () => making.delete(agent.id);
  void made.then(forget, forget);
  return made;
}
