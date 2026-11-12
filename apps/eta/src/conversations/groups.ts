/**
 * Making a group: the rules `conversations.create` applies, in one place, so the user's dialog and
 * Captain's confirmed proposal make the same kind of group.
 *
 * Who is in it (the project's steward when nobody is named), that a steward of its own is one of
 * them, what it is called when nobody named it (the project's name), and that a steward equal to the
 * project's is followed rather than copied, so changing the project's later still counts.
 */
import type { AgentStore } from "../agents/store";
import type { ProjectStore } from "../projects/store";
import type { ConversationRecord, ConversationStore } from "./store";
import { defaultGroupName } from "./views";

export interface GroupDeps {
  agents: AgentStore;
  projects: ProjectStore;
  conversations: ConversationStore;
}

export interface NewGroup {
  projectId: string;
  agentIds: readonly string[];
  stewardId?: string | undefined;
  name?: string | undefined;
  goal?: string | undefined;
}

export function createGroup(
  deps: GroupDeps,
  input: NewGroup,
): ConversationRecord {
  const { agents, projects, conversations } = deps;
  const agent = (id: string): string => {
    if (agents.get(id) === undefined) throw new Error(`no such agent: ${id}`);
    return id;
  };
  const project = projects.get(input.projectId);
  if (project === undefined) throw new Error("no such project");
  let members = [...new Set(input.agentIds.map(agent))];
  // A conversation nobody is in would be an empty room: the project's steward is there.
  if (members.length === 0 && project.stewardId !== null)
    members = [project.stewardId];
  const stewardId = input.stewardId;
  if (stewardId !== undefined && !members.includes(agent(stewardId)))
    throw new Error("the steward has to be a member");
  const given = input.name?.trim();
  // A group nobody named takes the project's name, not the names of who is in it.
  const name =
    given === undefined || given === ""
      ? defaultGroupName(
          project.name,
          members.map((id) => agents.get(id)?.name),
        )
      : given;
  const conversation = conversations.create({
    projectId: project.id,
    kind: "group",
    name,
    agentIds: members,
    // The project's own is followed rather than copied, so changing it later still counts.
    stewardId: stewardId === project.stewardId ? undefined : stewardId,
  });
  const goal = input.goal?.trim();
  if (goal === undefined || goal === "") return conversation;
  return conversations.update(conversation.id, { goal })!;
}

/** A group in the project, not archived, already called `name`: the one a new group would clash with. */
export function groupNamed(
  conversations: ConversationStore,
  projectId: string,
  name: string,
): ConversationRecord | undefined {
  const wanted = name.trim();
  return conversations
    .list()
    .find(
      (conversation) =>
        conversation.projectId === projectId &&
        conversation.kind === "group" &&
        !conversation.archived &&
        conversation.name.trim() === wanted,
    );
}
