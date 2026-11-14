import type { AgentRecord } from "../agents/store";
/**
 * An agent's private chat in a project: found, made if there is none, brought back if it was put
 * away. The agent dialog's "message", Captain's own conversation and an email handed to an agent
 * all open it this way.
 */
import type { ProjectRecord } from "../projects/store";
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
