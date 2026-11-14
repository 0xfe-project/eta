/**
 * An agent's home: its workspace directory under the data directory (`agentHome`) and the project
 * on the primary machine that stands for it (kind `agent_home`, stewarded by the agent).
 *
 * The project is made with the agent, in `writeAgent`. Everything else finds it here, and only
 * `ensureHome` makes one besides — for a Captain an older build made without it.
 */
import type { MachineStore } from "../machines/store";
import type { ProjectRecord, ProjectStore } from "../projects/store";
import type { AgentRecord, AgentStore } from "./store";
import { agentHome } from "./store";

export interface HomeDeps {
  dataDir: string;
  machines: MachineStore;
  projects: ProjectStore;
}

/** The agent's home project; undefined when there is no primary machine or no such project. */
export function homeOf(
  deps: HomeDeps,
  agent: Pick<AgentRecord, "id">,
): ProjectRecord | undefined {
  const primary = deps.machines.primary();
  if (primary === undefined) return undefined;
  return deps.projects.byPath(primary.id, agentHome(deps.dataDir, agent.id));
}

/**
 * The agent's home project, made if it is missing. Only for an agent that should have one and was
 * made before it always came with one: Captain from an older build (`CaptainService.ensure`).
 */
export function ensureHome(
  deps: HomeDeps,
  agent: Pick<AgentRecord, "id" | "name">,
): ProjectRecord {
  const found = homeOf(deps, agent);
  if (found !== undefined) return found;
  const primary = deps.machines.primary();
  if (primary === undefined)
    throw new Error("this host has no primary machine");
  return deps.projects.create({
    machineId: primary.id,
    path: agentHome(deps.dataDir, agent.id),
    name: agent.name,
    kind: "agent_home",
    stewardId: agent.id,
  });
}

/** Whether a path on the primary machine is some agent's own workspace. */
export function isAgentHome(
  deps: { dataDir: string; agents: AgentStore },
  path: string,
): boolean {
  return deps.agents
    .list()
    .some((agent) => agentHome(deps.dataDir, agent.id) === path);
}
