/**
 * Making a group: the rules `conversations.create` applies, in one place, so the user's dialog and
 * Captain's confirmed proposal make the same kind of group.
 *
 * Who is in it (at least one agent), who its steward is (one of them, chosen when it is made: the
 * first member unless the caller says otherwise, or nobody), and what it is called when nobody named
 * it (the project's name). A project has no steward to fall back on: the group's is its own.
 */
import type { AgentStore } from "../agents/store";
import type { MachineStore } from "../machines/store";
import type { ProjectStore } from "../projects/store";
import type { ConversationRecord, ConversationStore } from "./store";
import { checkExternalAgentProject } from "../agents/bounds";
import { defaultGroupName } from "./views";

export interface GroupDeps {
  agents: AgentStore;
  machines: MachineStore;
  projects: ProjectStore;
  conversations: ConversationStore;
}

export interface NewGroup {
  projectId: string;
  agentIds: readonly string[];
  /** One of `agentIds`, or null for none; left out, the first of them. */
  stewardId?: string | null | undefined;
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
  const members = [...new Set(input.agentIds.map(agent))];
  // A conversation nobody is in would be an empty room.
  if (members.length === 0)
    throw new Error("a group needs at least one member");
  for (const id of members)
    checkExternalAgentProject(agents.get(id)!, project, deps.machines);
  const stewardId =
    input.stewardId === undefined ? members[0]! : input.stewardId;
  if (stewardId !== null && !members.includes(agent(stewardId)))
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
    stewardId,
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
