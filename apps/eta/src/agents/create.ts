/**
 * Making an agent: the rules `agents.create` applies, in one place, so the user's dialog and
 * Captain's confirmed proposal make the same kind of agent.
 *
 * An agent comes with a workspace directory and a home project (kind `agent_home`, stewarded by the
 * agent) on the primary machine. The agent, the project and its plugins are written in one
 * transaction; a failure takes the directory away again. Its first instructions and persona start
 * their prompt histories, recorded as whoever asked for it (the user, or Captain).
 */
import type { AgentRuntime, ThinkingLevel } from "@eta/client-contracts";
import type { Database } from "bun:sqlite";
import type { MachineStore } from "../machines/store";
import type { Plugins } from "../plugins/service";
import type { ProjectRecord, ProjectStore } from "../projects/store";
import type { AgentRecord, AgentStore } from "./store";
import { mkdir, rm } from "node:fs/promises";
import { requireModel } from "./model";
import { agentHome } from "./store";

export interface AgentCreateDeps {
  dataDir: string;
  db: Database;
  agents: AgentStore;
  machines: MachineStore;
  projects: ProjectStore;
  plugins: Plugins;
  /** Append to an agent's prompt history (the Captain store's). */
  capturePrompt?:
    | ((input: {
        agentId: string;
        kind: "instructions" | "persona";
        content: string;
        actorAgentId: string | null;
      }) => void)
    | undefined;
}

export interface NewAgent {
  name: string;
  instructions?: string | undefined;
  /** The id of a persona card: sessions find the card by it (`resolvePersona`). */
  persona?: string | undefined;
  runtime?: AgentRuntime | undefined;
  model?: string | null | undefined;
  thinkingLevel?: ThinkingLevel | null | undefined;
  machineId?: string | null | undefined;
  plugins?: readonly string[] | undefined;
}

/**
 * Whether an agent could be made from `input` as things are now; throws saying why not. Nothing is
 * written, so a proposal can be checked with it long before it is made.
 */
export function checkNewAgent(
  deps: Pick<AgentCreateDeps, "agents" | "machines" | "plugins">,
  input: NewAgent,
): void {
  const name = input.name.trim();
  if (name === "") throw new Error("an agent needs a name");
  checkAgentName(deps.agents, name);
  requireModel(input.runtime ?? "eta", input.model ?? null);
  checkMachine(deps.machines, input.machineId);
  checkPlugins(deps.plugins, undefined, input.plugins);
  if (deps.machines.primary() === undefined)
    throw new Error("this host has no machine");
}

/**
 * Make the agent, its workspace and its home project, after `checkNewAgent`. `actorAgentId` is who
 * the first prompt versions are recorded as: null for the user, Captain's id for its proposal.
 */
export async function createAgent(
  deps: AgentCreateDeps,
  input: NewAgent,
  actorAgentId: string | null,
): Promise<{ agent: AgentRecord; project: ProjectRecord }> {
  checkNewAgent(deps, input);
  const { agents, projects, plugins } = deps;
  const primary = deps.machines.primary()!;
  const name = input.name.trim();
  const id = crypto.randomUUID();
  const home = agentHome(deps.dataDir, id);
  await mkdir(home, { recursive: true });
  let made: { agent: AgentRecord; project: ProjectRecord };
  try {
    // The agent and its workspace appear together or not at all.
    made = deps.db.transaction(() => {
      const { plugins: wanted, ...fields } = input;
      const agent = agents.create({ ...fields, name }, id);
      const project = projects.create({
        machineId: primary.id,
        path: home,
        name,
        kind: "agent_home",
        stewardId: id,
      });
      if (wanted !== undefined) plugins.rows.setEnabled(id, [...wanted]);
      return { agent, project };
    })();
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
  for (const kind of ["instructions", "persona"] as const)
    deps.capturePrompt?.({
      agentId: id,
      kind,
      content: made.agent[kind],
      actorAgentId,
    });
  return made;
}

/** An agent other than `except` that already answers to `name`, compared without case. */
function agentNamed(
  agents: AgentStore,
  name: string,
  except?: string,
): AgentRecord | undefined {
  const wanted = name.trim().toLowerCase();
  return agents
    .list()
    .find(
      (agent) =>
        agent.id !== except && agent.name.trim().toLowerCase() === wanted,
    );
}

/**
 * Names are how agents are told apart: a mention, the members of a group, the agent list. A second
 * agent of the same name is refused, whether the user or Captain asks for it.
 */
export function checkAgentName(
  agents: AgentStore,
  name: string,
  except?: string,
): void {
  if (agentNamed(agents, name, except) !== undefined)
    throw new Error(`an agent named "${name.trim()}" already exists`);
}

/** A machine an agent can be pinned to: the primary or a daemon that was let in. */
export function checkMachine(
  machines: MachineStore,
  machineId: string | null | undefined,
): void {
  if (machineId === undefined || machineId === null) return;
  const machine = machines.get(machineId);
  if (
    machine === undefined ||
    (machine.kind !== "primary" && machine.kind !== "daemon")
  )
    throw new Error(`no such machine: ${machineId}`);
  if (machine.status === "revoked" || machine.status === "pending")
    throw new Error(
      `${machine.name} is ${machine.status}: an agent cannot run there`,
    );
}

/** What an agent can be set to use: what it has already, and what can be enabled. */
export function checkPlugins(
  plugins: Plugins,
  agentId: string | undefined,
  wanted: readonly string[] | undefined,
): void {
  if (wanted === undefined) return;
  const has = agentId === undefined ? [] : plugins.rows.enabled(agentId);
  for (const name of wanted)
    if (!has.includes(name) && !plugins.canEnable(name))
      throw new Error(`plugin ${name} cannot be enabled: it needs configuring`);
}
