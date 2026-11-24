/**
 * Captain's conversation: Captain and the user, and nobody else.
 *
 * It is a conversation like any other for what is said in it (the timeline, replies, steering,
 * stopping, attachments), and the captain module's own for the rest: a message goes to Captain
 * whether it names Captain or not, nobody joins or leaves, nothing about it is edited, and it is
 * not a row of the conversation list — a client reaches it through `captain.direct`.
 */
import type { AgentRecord } from "../agents/store";
import type { ConversationPolicy } from "../conversations/policy";
import type {
  ConversationRecord,
  ConversationStore,
} from "../conversations/store";

import { routeCaptainMessage } from "@eta/client-contracts/routing";

export const CAPTAIN_KIND = "captain";

export function captainPolicy(deps: {
  conversations: ConversationStore;
}): ConversationPolicy {
  return {
    kind: CAPTAIN_KIND,
    // There is only Captain to talk to: a message that names nobody is for Captain all the same.
    route: routeCaptainMessage,
    canChangeMembers: () => false,
    membersFixed: "Captain's conversation is Captain and the user",
    updateRefusal: () => "Captain's conversation cannot be changed",
    listed: false,
    describe: () => ({ note: "a private chat with the user", lines: [] }),
    onAgentRenamed: (agent) => {
      if (agent.systemRole !== "captain") return;
      for (const conversation of captainConversations(
        deps.conversations,
        agent,
      ))
        deps.conversations.update(conversation.id, { name: agent.name });
    },
  };
}

/** Captain's conversations, oldest first: one, unless something went wrong. */
export function captainConversations(
  conversations: ConversationStore,
  agent: Pick<AgentRecord, "id">,
): ConversationRecord[] {
  return conversations
    .ofKind(CAPTAIN_KIND)
    .filter(
      (conversation) =>
        conversations.participant(conversation.id, agent.id) !== undefined,
    );
}
