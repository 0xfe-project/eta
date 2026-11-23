/**
 * An agent's private chat in a project: found, made if there is none, brought back if it was put
 * away. The agent dialog's "message", Captain's own conversation and an email handed to an agent
 * all open it this way.
 */
import type { AgentRecord, AgentStore } from "../agents/store";
import type { ProjectRecord } from "../projects/store";
import type { ConversationPolicy } from "./policy";
import type { ConversationRecord, ConversationStore } from "./store";

export interface DirectDeps {
  conversations: ConversationStore;
  /** A conversation exists now: its wire target has to be published. */
  created?: ((conversationId: string) => void) | undefined;
  /** A conversation was made or brought back; left out by a caller that publishes it itself. */
  changed?: ((conversationIds: readonly string[]) => void) | undefined;
}

export function openDirect(
  deps: DirectDeps,
  project: Pick<ProjectRecord, "id">,
  agent: Pick<AgentRecord, "id" | "name">,
): ConversationRecord {
  const { conversations } = deps;
  const found = conversations.directOf(project.id, agent.id);
  if (found === undefined) {
    const made = conversations.create({
      projectId: project.id,
      kind: "direct",
      name: agent.name,
      agentIds: [agent.id],
      // The only one there is to talk to; the composer shows it as who a message goes to.
      stewardId: agent.id,
    });
    deps.created?.(made.id);
    deps.changed?.([made.id]);
    return made;
  }
  if (!found.archived) return found;
  const back = conversations.update(found.id, { archived: false })!;
  deps.changed?.([back.id]);
  return back;
}

/**
 * The private chat: the agent and the user, nobody else. A message goes to the agent whether it
 * names it or not; nobody joins or leaves; it carries the agent's name and is put away with it.
 */
export function directPolicy(deps: {
  agents: AgentStore;
  conversations: ConversationStore;
  /** The agent's home project, where its private chats are named after it. */
  homeOf: (agent: AgentRecord) => Pick<ProjectRecord, "id"> | undefined;
}): ConversationPolicy {
  const { agents, conversations } = deps;
  /** The private chat with the Captain agent. */
  const isCaptains = (conversation: ConversationRecord): boolean =>
    conversations
      .participants(conversation.id)
      .some((p) => agents.get(p.agentId)?.systemRole === "captain");
  return {
    kind: "direct",
    route: (input) => {
      const named = [...new Set(input.mentions)].filter((id) =>
        input.members.includes(id),
      );
      if (named.length > 0) return { targets: named, named };
      // A private chat is the agent and the user: nobody else could be meant.
      const only = input.members[0];
      return { targets: only === undefined ? [] : [only], named };
    },
    canChangeMembers: () => false,
    membersFixed: "a private chat is the agent and the user",
    // Captain's conversation is the way to Captain: archived, Captain would leave the sidebar
    // with nothing that brings it back.
    updateRefusal: (conversation, patch) =>
      patch.archived === true && isCaptains(conversation)
        ? "Captain's conversation cannot be archived"
        : undefined,
    listed: true,
    describe: () => ({ note: "a private chat with the user", lines: [] }),
    onAgentRenamed: (agent) => {
      const home = deps.homeOf(agent);
      if (home !== undefined) conversations.renameDirect(home.id, agent.name);
    },
    onAgentDeleted: (agent) => {
      conversations.archiveDirectOf(agent.id);
    },
  };
}
