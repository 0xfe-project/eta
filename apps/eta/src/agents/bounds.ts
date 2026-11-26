import type { AgentRuntime } from "@eta/client-contracts";
import type { ConversationStore } from "../conversations/store";
import type { MachineStore } from "../machines/store";
import type { ProjectRecord, ProjectStore } from "../projects/store";
import type { AgentRecord } from "./store";
import { isExternalRuntime } from "@eta/client-contracts";

/** Readable label for a machine id, falling back to the raw id when its row is gone. */
function machineLabel(machines: MachineStore, machineId: string): string {
  return machines.get(machineId)?.name ?? machineId;
}

/**
 * External runtimes (`runtime !== "eta"`) never wear a persona card.
 */
export function checkExternalPersona(
  runtime: AgentRuntime,
  persona: string | undefined,
): void {
  if (!isExternalRuntime(runtime)) return;
  if (persona !== undefined && persona.trim() !== "")
    throw new Error(`agents on ${runtime} cannot take a persona card`);
}

/**
 * External runtimes (`runtime !== "eta"`) must always be pinned to a concrete machine.
 */
export function checkExternalMachineRequired(
  runtime: AgentRuntime,
  machineId: string | null | undefined,
): void {
  if (!isExternalRuntime(runtime)) return;
  if (machineId === undefined || machineId === null)
    throw new Error(`agents on ${runtime} must be pinned to a machine`);
}

/**
 * Whether `agent` is forbidden from running in `project` under single-machine bounds for
 * external runtimes. Returns a clear, actionable message when forbidden, or `undefined` when OK.
 *
 * - Built-in `"eta"` agents are unconstrained.
 * - On an `agent_home` project: only the owning agent may run there (its home directory row lives
 *   on primary while its external sessions run on `agent.machineId`).
 * - On any regular project: an external agent may participate or run only when pinned to the
 *   project's own machine.
 */
export function externalAgentProjectError(
  agent: Pick<AgentRecord, "id" | "name" | "runtime" | "machineId">,
  project: Pick<ProjectRecord, "kind" | "ownerAgentId" | "machineId">,
  machines: MachineStore,
): string | undefined {
  if (!isExternalRuntime(agent.runtime)) return undefined;
  if (agent.machineId === null)
    return `${agent.name} runs on ${agent.runtime} and must be pinned to a machine`;
  if (project.kind === "agent_home") {
    if (project.ownerAgentId === agent.id) return undefined;
    return `${agent.name} runs on ${agent.runtime} and cannot be used in another agent's home workspace`;
  }
  if (agent.machineId !== project.machineId)
    return `${agent.name} runs on ${agent.runtime} (${machineLabel(machines, agent.machineId)}), so it cannot be used in a project on ${machineLabel(machines, project.machineId)}`;
  return undefined;
}

/**
 * Throw when `agent` violates single-machine bounds in `project`.
 */
export function checkExternalAgentProject(
  agent: Pick<AgentRecord, "id" | "name" | "runtime" | "machineId">,
  project: Pick<ProjectRecord, "kind" | "ownerAgentId" | "machineId">,
  machines: MachineStore,
): void {
  const problem = externalAgentProjectError(agent, project, machines);
  if (problem !== undefined) throw new Error(problem);
}

/**
 * Refuse changing an external agent's machine or switching an agent to an external runtime while it
 * still belongs to non-archived regular groups on another machine. Unrelated edits (name, model,
 * instructions, plugins) that keep `machineId` unchanged on an already-external agent are allowed.
 */
export function checkExternalMachineChange(
  deps: {
    conversations: ConversationStore;
    projects: ProjectStore;
    machines: MachineStore;
  },
  before: AgentRecord,
  nextRuntime: AgentRuntime,
  nextMachineId: string | null,
): void {
  if (!isExternalRuntime(nextRuntime)) return;
  const movingToExternal = !isExternalRuntime(before.runtime);
  const changingMachine = nextMachineId !== before.machineId;
  if (!movingToExternal && !changingMachine) return;
  if (nextMachineId === null) return;

  const conflicts: string[] = [];
  for (const conversation of deps.conversations.list()) {
    if (conversation.archived || conversation.kind !== "group") continue;
    if (
      deps.conversations.participant(conversation.id, before.id) === undefined
    )
      continue;
    const project = deps.projects.get(conversation.projectId);
    if (
      project === undefined ||
      project.kind === "agent_home" ||
      project.machineId === nextMachineId
    )
      continue;
    conflicts.push(
      `${conversation.name} (${machineLabel(deps.machines, project.machineId)})`,
    );
  }
  if (conflicts.length > 0)
    throw new Error(
      `${before.name} runs on ${nextRuntime} and cannot be pinned to ${machineLabel(deps.machines, nextMachineId)} while still in groups on other machines: ${conflicts.join(", ")}`,
    );
}
