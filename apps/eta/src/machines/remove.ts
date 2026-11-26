/**
 * Previewing and executing hard machine removal.
 *
 * Removing a daemon machine stops all active replies and open task runs on it (or belonging to
 * agents pinned to it), cuts its link cleanly with `4003`, deletes every pinned agent BEFORE
 * deleting the machine row (so `ON DELETE SET NULL` never clears external agents' `machine_id`),
 * cascades projects/conversations/messages/participants/places via SQLite FKs, and tidies wire
 * targets, caches, and attachment directories on disk.
 */
import type {
  MachineRemovePreview,
  MachineRemoveResult,
} from "@eta/client-contracts";
import type { Database } from "bun:sqlite";
import type { AcpService } from "../acp/service";
import type { AgentRecord, AgentStore } from "../agents/store";
import type { AttachmentStore } from "../conversations/attachments";
import type { Engine } from "../conversations/engine";
import type { ConversationPolicies } from "../conversations/policy";
import type {
  ConversationRecord,
  ConversationStore,
} from "../conversations/store";
import type { ConversationTargets } from "../conversations/targets";
import type { Timeline } from "../conversations/timeline";
import type { Plugins } from "../plugins/service";
import type { ProjectRecord, ProjectStore } from "../projects/store";
import type { TaskRunner } from "../tasks/runner";
import type { TaskRunStore } from "../tasks/runs";
import type { MachineHub } from "./hub";
import type { SessionMirrors } from "./mirror";
import type { MachineRecord, MachineStore } from "./store";
import { deleteAgentInTransaction } from "../agents/delete";

export interface RemoveMachineDeps {
  dataDir: string;
  db: Database;
  machines: MachineStore;
  agents: AgentStore;
  projects: ProjectStore;
  conversations: ConversationStore;
  policies: ConversationPolicies;
  timeline: Timeline;
  engine: Pick<Engine, "stop" | "stopAgent">;
  runs: Pick<TaskRunStore, "openForMachineOrAgents">;
  runner: Pick<TaskRunner, "stopForMachine">;
  hub: Pick<MachineHub, "disconnectForRemoval">;
  targets: Pick<ConversationTargets, "remove">;
  attachments: Pick<AttachmentStore, "dropConversation">;
  mirrors?: Pick<SessionMirrors, "dropMachine"> | undefined;
  plugins?: Pick<Plugins, "forgetMachine"> | undefined;
  acp?: Pick<AcpService, "forgetMachine"> | undefined;
  changed: (conversations?: readonly string[] | "all") => void;
  pushAfterRemove: () => void;
}

interface MachineImpactSnapshot {
  machine: MachineRecord;
  agents: AgentRecord[];
  projects: ProjectRecord[];
  conversations: ConversationRecord[];
  activeRuns: number;
  activeReplies: number;
}

function snapshotMachineImpact(
  deps: Pick<
    RemoveMachineDeps,
    "machines" | "agents" | "projects" | "conversations" | "runs" | "timeline"
  >,
  machineId: string,
): MachineImpactSnapshot {
  const machine = deps.machines.get(machineId);
  if (machine === undefined) throw new Error(`no such machine: ${machineId}`);
  if (machine.kind !== "daemon")
    throw new Error(`${machine.name} is not a daemon machine`);

  const agents = deps.agents
    .list()
    .filter(
      (agent) =>
        agent.machineId === machine.id && agent.systemRole !== "captain",
    );
  const agentIds = agents.map((agent) => agent.id);
  const agentIdSet = new Set(agentIds);

  const projects = deps.projects
    .list()
    .filter((project) => project.machineId === machine.id);
  const projectIdSet = new Set(projects.map((project) => project.id));

  const conversations = deps.conversations
    .list()
    .filter((conversation) => projectIdSet.has(conversation.projectId));
  const conversationIdSet = new Set(
    conversations.map((conversation) => conversation.id),
  );

  const activeRuns = deps.runs.openForMachineOrAgents(
    machine.id,
    agentIds,
  ).length;
  const activeReplies = deps.timeline
    .active()
    .filter(
      (row) =>
        conversationIdSet.has(row.conversationId) ||
        (row.agentId !== null && agentIdSet.has(row.agentId)),
    ).length;

  return {
    machine,
    agents,
    projects,
    conversations,
    activeRuns,
    activeReplies,
  };
}

/** Preview every entity and in-flight turn that removing `machineId` will remove or stop. */
export function previewRemoveMachine(
  deps: Pick<
    RemoveMachineDeps,
    "machines" | "agents" | "projects" | "conversations" | "runs" | "timeline"
  >,
  machineId: string,
): MachineRemovePreview {
  const impact = snapshotMachineImpact(deps, machineId);
  return {
    machine: { id: impact.machine.id, name: impact.machine.name },
    agents: impact.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      runtime: agent.runtime,
    })),
    projects: impact.projects.map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path,
    })),
    conversations: impact.conversations.map((conversation) => ({
      id: conversation.id,
      name: conversation.name,
      projectId: conversation.projectId,
      archived: conversation.archived,
    })),
    activeRuns: impact.activeRuns,
    activeReplies: impact.activeReplies,
  };
}

/** Permanently remove a daemon machine and synchronously clean up all dependent records and work. */
export async function removeMachine(
  deps: RemoveMachineDeps,
  machineId: string,
): Promise<MachineRemoveResult> {
  const impact = snapshotMachineImpact(deps, machineId);
  const agentIds = impact.agents.map((agent) => agent.id);
  const projectIds = impact.projects.map((project) => project.id);
  const conversationIds = impact.conversations.map(
    (conversation) => conversation.id,
  );

  // Cut live daemon link and clear per-machine caches first.
  deps.hub.disconnectForRemoval(impact.machine.id);
  deps.acp?.forgetMachine(impact.machine.id);
  deps.mirrors?.dropMachine(impact.machine.id);
  deps.plugins?.forgetMachine(impact.machine.id);

  // Stop all in-flight replies and open task runs before deleting database rows.
  for (const conversationId of conversationIds)
    deps.engine.stop(conversationId);
  for (const agentId of agentIds) deps.engine.stopAgent(agentId);
  deps.runner.stopForMachine(
    impact.machine.id,
    agentIds,
    `Machine ${impact.machine.name} was removed.`,
  );

  // Execute all database removals atomically in a single transaction.
  deps.db.transaction(() => {
    // 1. Delete pinned agents FIRST so ON DELETE SET NULL on agent.machine_id never clears
    //    external agents' machine_id before they are removed.
    for (const agent of impact.agents) deleteAgentInTransaction(deps, agent);
    // 2. Clear any remaining participant session pointers referencing this machine.
    deps.conversations.clearSessionsOnMachine(impact.machine.id);
    // 3. Delete the machine row (cascades projects, conversations, messages, participants,
    //    attachments, captain_assignment, place_recent, place_clone_parent; sets NULL on tasks,
    //    artifacts, and machine_enrollment).
    deps.machines.remove(impact.machine.id);
  })();

  // Unregister wire targets, remove on-disk attachment directories, and notify subscribers.
  for (const conversationId of conversationIds)
    deps.targets.remove(conversationId);
  await Promise.all(
    conversationIds.map((conversationId) =>
      deps.attachments.dropConversation(conversationId),
    ),
  );
  deps.changed("all");
  deps.pushAfterRemove();

  return {
    machineId: impact.machine.id,
    removedAgents: agentIds,
    removedProjects: projectIds,
    removedConversations: conversationIds,
  };
}
