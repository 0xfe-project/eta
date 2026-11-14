/**
 * Captain proposes a group (`propose_group`); confirming it adds the directory as a project when it
 * is not one, stewarded by the group's steward as the dialog does it, then makes the group, its goal
 * and the line that says who made it (`createGroup`, the dialog's own rules).
 */
import type {
  CaptainGroupProposal,
  CaptainGroupResult,
} from "@eta/client-contracts";
import type { AgentStore } from "../agents/store";
import type { ConversationStore } from "../conversations/store";
import type { Timeline } from "../conversations/timeline";
import type { MachineRecord, MachineStore } from "../machines/store";
import type { ProjectRecord, ProjectStore } from "../projects/store";
import type { ProposalKind, ProposalOrigin } from "./proposals";
import { basename, isAbsolute, resolve } from "node:path";
import { agentHome } from "../agents/store";
import { createGroup, groupNamed } from "../conversations/groups";

/** What Captain asks for when it proposes a group. */
export interface GroupProposalInput {
  name: string;
  projectId?: string | undefined;
  path?: string | undefined;
  machineId?: string | undefined;
  memberIds: readonly string[];
  stewardId: string;
  goal?: string | undefined;
}

/** A group proposal as it is stored, without where it was proposed. */
type GroupProposal = Omit<CaptainGroupProposal, keyof ProposalOrigin>;

/** A group of that name is already in the project: the proposal would make a second one. */
export class GroupConflictError extends Error {
  readonly conversationId: string;

  constructor(name: string, conversationId: string) {
    super(
      `a group named "${name}" already exists in this project (conversationId ${conversationId})`,
    );
    this.conversationId = conversationId;
  }
}

export interface GroupProposalDeps {
  dataDir: string;
  agents: AgentStore;
  machines: MachineStore;
  projects: ProjectStore;
  conversations: ConversationStore;
  timeline: Timeline;
  /** A conversation exists now: its wire target has to be published. */
  created?: ((conversationId: string) => void) | undefined;
  changed: (conversationIds?: readonly string[]) => void;
  /** Whether a path is a directory on the machine; throws saying why not (`projects/check.ts`). */
  checkDirectory: (machine: MachineRecord, path: string) => Promise<void>;
  captainId: () => string | undefined;
}

export function groupProposals(
  deps: GroupProposalDeps,
): ProposalKind<GroupProposalInput, GroupProposal, CaptainGroupResult> {
  /** The project a proposal names, or the directory it would add: as things are now. */
  const placeOf = async (
    input: GroupProposalInput,
  ): Promise<{
    project: ProjectRecord | undefined;
    machine: MachineRecord;
    path: string;
  }> => {
    const byId = input.projectId !== undefined && input.projectId !== "";
    const byPath = input.path !== undefined && input.path !== "";
    if (byId === byPath)
      throw new Error("give either projectId or path, not both or neither");
    if (byId) {
      const project = deps.projects.get(input.projectId!);
      if (project === undefined)
        throw new Error(`no such project: ${input.projectId}`);
      const machine = deps.machines.get(project.machineId);
      if (machine === undefined) throw new Error("no such machine");
      return { project, machine, path: project.path };
    }
    const machineId = input.machineId || deps.machines.primary()?.id;
    const machine =
      machineId === undefined ? undefined : deps.machines.get(machineId);
    if (machine === undefined) throw new Error("no such machine");
    if (!isAbsolute(input.path!))
      throw new Error(`the path must be absolute: ${input.path}`);
    const path = resolve(input.path!);
    // A directory that is a project already is that project, the way adding it again is.
    const project = deps.projects.byPath(machine.id, path);
    if (project === undefined) {
      if (
        machine.kind === "primary" &&
        deps.agents
          .list()
          .some((agent) => agentHome(deps.dataDir, agent.id) === path)
      )
        throw new Error(`${path} is an agent's own workspace`);
      await deps.checkDirectory(machine, path);
    }
    return { project, machine, path };
  };

  return {
    kind: "create_group",
    noun: "group",

    /**
     * Refused: a directory that is missing, a file, an agent's own workspace or an archived project;
     * a member that is gone or is Captain; a steward who is not a member; a group of the same name in
     * the same project.
     */
    async check(input) {
      const captainId = deps.captainId();
      const name = input.name.trim();
      if (name === "") throw new Error("a group needs a name");
      const memberIds = [...new Set(input.memberIds)];
      if (memberIds.length === 0)
        throw new Error("a group needs at least one member");
      for (const agentId of memberIds) {
        if (agentId === captainId)
          throw new Error("Captain cannot be a member of a group it proposes");
        if (deps.agents.get(agentId) === undefined)
          throw new Error(`member ${agentId} does not exist`);
      }
      if (!memberIds.includes(input.stewardId))
        throw new Error("the steward has to be a member");
      const { project, machine, path } = await placeOf(input);
      if (project !== undefined) {
        if (project.kind === "agent_home")
          throw new Error(`${project.path} is an agent's own workspace`);
        if (project.archived)
          throw new Error(`the project ${project.name} is archived`);
        const clash = groupNamed(deps.conversations, project.id, name);
        if (clash !== undefined) throw new GroupConflictError(name, clash.id);
      }
      return {
        name,
        goal: input.goal?.trim() || null,
        memberIds,
        stewardId: input.stewardId,
        projectId: project?.id ?? null,
        machineId: machine.id,
        path,
        projectName: project?.name ?? projectNameOf(path),
      };
    },

    // A directory that was not a project when proposed is looked up again by its path: it may be
    // one now.
    again: (proposal) => ({
      name: proposal.name,
      ...(proposal.projectId === null
        ? { path: proposal.path, machineId: proposal.machineId }
        : { projectId: proposal.projectId }),
      memberIds: proposal.memberIds,
      stewardId: proposal.stewardId,
      goal: proposal.goal ?? undefined,
    }),

    async apply(proposal, operation) {
      const project =
        (proposal.projectId === null
          ? undefined
          : deps.projects.get(proposal.projectId)) ??
        deps.projects.create({
          machineId: proposal.machineId,
          path: proposal.path,
          name: proposal.projectName,
          stewardId: proposal.stewardId,
        });
      const group = createGroup(deps, {
        projectId: project.id,
        agentIds: proposal.memberIds,
        stewardId: proposal.stewardId,
        name: proposal.name,
        goal: proposal.goal ?? undefined,
      });
      deps.timeline.system(group.id, "Created by Captain.", {
        event: "captain_created",
        operationId: operation.id,
        agentId: operation.actorAgentId,
      });
      deps.created?.(group.id);
      deps.changed([group.id]);
      return {
        conversationId: group.id,
        projectId: project.id,
        projectCreated: proposal.projectId === null,
      };
    },

    created: (proposal, result) => [
      `conversationId: ${result.conversationId}`,
      `projectId: ${result.projectId}${result.projectCreated ? ` (${proposal.path} was added as a new project)` : ""}`,
      "Assign work there with assign_in_group.",
    ],
  };
}

/** What a directory that becomes a project is called: its last segment. */
function projectNameOf(path: string): string {
  return basename(path) || path;
}
