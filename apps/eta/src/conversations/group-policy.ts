/**
 * The group: the conversation this module is about. A user message goes to the members it names,
 * else to the steward, else to the only member (`routing.ts`); members come and go; every group is a
 * row of the list.
 */
import type { AgentStore } from "../agents/store";
import type { ConversationPolicy } from "./policy";
import type { ConversationStore } from "./store";
import { routeUserMessage } from "./routing";

export function groupPolicy(deps: {
  agents: AgentStore;
  conversations: ConversationStore;
}): ConversationPolicy {
  return {
    kind: "group",
    route: routeUserMessage,
    canChangeMembers: () => true,
    updateRefusal: () => undefined,
    listed: true,
    describe: (conversation) => ({
      lines: [
        stewardLine(
          conversation.stewardId,
          deps.conversations.participants(conversation.id).length,
          deps.agents,
        ),
      ],
    }),
  };
}

function stewardLine(
  steward: string | null,
  members: number,
  agents: AgentStore,
): string {
  if (steward !== null)
    return `Steward: ${agents.get(steward)?.name ?? "(deleted)"} (takes the user's messages that @mention nobody)`;
  return members === 1
    ? "Steward: none (the user's messages that @mention nobody go to the only member)"
    : "Steward: none (a user message that @mentions nobody wakes nobody)";
}
