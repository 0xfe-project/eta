/**
 * Making an agent: the rules `agents.create` applies, in one place, so the user's dialog and
 * Captain's confirmed proposal make the same kind of agent.
 *
 * An agent comes with a workspace directory and a home project (kind `agent_home`, owned by the
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
import { isExternalRuntime } from "@eta/client-contracts";
import { checkExternalMachineRequired, checkExternalPersona } from "./bounds";
import { requireModel } from "./model";
import { agentHome } from "./store";

/** Captain's name: no other agent may take it, in any case (`checkAgentName`). */
const CAPTAIN_NAME = "Captain";

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
  const runtime = input.runtime ?? "eta";
  checkAgentName(deps.agents, name);
  checkExternalPersona(runtime, input.persona);
  checkExternalMachineRequired(runtime, input.machineId);
  requireModel(runtime, input.model ?? null);
  checkMachine(deps.machines, input.machineId);
  checkPlugins(deps.plugins, undefined, input.plugins);
  if (deps.machines.primary() === undefined)
    throw new Error("this host has no machine");
}

/**
 * Make an ordinary agent: `checkNewAgent`, then write it. `actorAgentId` is who the first prompt
 * versions are recorded as: null for the user, Captain's id for its proposal.
 *
 * The rules live here rather than with each caller because the write below is not exported: there
 * is no way to make an agent that skips them, short of `createCaptainIdentity`.
 */
export async function createAgent(
  deps: AgentCreateDeps,
  input: NewAgent,
  actorAgentId: string | null,
): Promise<{ agent: AgentRecord; project: ProjectRecord }> {
  checkNewAgent(deps, input);
  // Only `createCaptainIdentity` gives an agent a system role, whatever `input` carries.
  return await writeAgent(
    deps,
    { ...input, systemRole: null },
    { actorAgentId },
  );
}

/**
 * Make Captain's own agent, when the host starts without one (`CaptainService.ensure`). It skips
 * the rules `createAgent` applies, on purpose:
 *
 * - its name: it is always called "Captain", the name no other agent may take. A user agent that
 *   took it before the name was reserved must not stop the host from starting, so the name is not
 *   checked against the others; whatever looks Captain up by name prefers the one with the system
 *   role (`resolveNamed`, `resolveAssignee`).
 * - its model: it has none until the user picks one (`CaptainService.setModel`).
 * - its machine and plugins: it runs on the primary and has none to check.
 *
 * It carries the captain system role, which no ordinary agent can. `within` adds rows that belong
 * to Captain's creation to the same transaction.
 */
export async function createCaptainIdentity(
  deps: AgentCreateDeps,
  input: { instructions: string },
  options: { within?: ((agent: AgentRecord) => void) | undefined },
): Promise<{ agent: AgentRecord; project: ProjectRecord }> {
  return await writeAgent(
    deps,
    {
      name: CAPTAIN_NAME,
      instructions: input.instructions,
      runtime: "eta",
      systemRole: "captain",
      machineId: null,
    },
    { actorAgentId: null, within: options.within },
  );
}

/**
 * Write an agent, with no rules about what it may be: the only place an agent row is made. Not
 * exported, so the only ways in are `createAgent`, which checks first, and `createCaptainIdentity`.
 *
 * The workspace directory comes first; then, in one transaction, the agent, its home project on the
 * primary machine, its plugins, its first instructions and persona versions, and whatever `within`
 * adds. A failure anywhere takes all of it back, the directory included.
 */
async function writeAgent(
  deps: AgentCreateDeps,
  input: NewAgent & { systemRole?: "captain" | null | undefined },
  options: {
    actorAgentId: string | null;
    /** More rows that belong to the agent's creation, written in the same transaction. */
    within?: ((agent: AgentRecord) => void) | undefined;
  },
): Promise<{ agent: AgentRecord; project: ProjectRecord }> {
  const { agents, projects, plugins } = deps;
  const primary = deps.machines.primary();
  if (primary === undefined) throw new Error("this host has no machine");
  const name = input.name.trim();
  const id = crypto.randomUUID();
  const home = agentHome(deps.dataDir, id);
  await mkdir(home, { recursive: true });
  try {
    // The agent and its workspace appear together or not at all.
    return deps.db.transaction(() => {
      const { plugins: wanted, ...fields } = input;
      const runtime = fields.runtime ?? "eta";
      const agent = agents.create(
        {
          ...fields,
          name,
          ...(isExternalRuntime(runtime) ? { persona: "" } : {}),
        },
        id,
      );
      const project = projects.create({
        machineId: primary.id,
        path: home,
        name,
        kind: "agent_home",
        ownerAgentId: id,
      });
      if (wanted !== undefined) plugins.rows.setEnabled(id, [...wanted]);
      for (const kind of ["instructions", "persona"] as const)
        deps.capturePrompt?.({
          agentId: id,
          kind,
          content: agent[kind],
          actorAgentId: options.actorAgentId,
        });
      options.within?.(agent);
      return { agent, project };
    })();
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
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

/** Whether `name` is Captain's, compared without case. */
function isCaptainName(name: string): boolean {
  return name.trim().toLowerCase() === CAPTAIN_NAME.toLowerCase();
}

/**
 * Names are how agents are told apart: a mention, the members of a group, the agent list. A second
 * agent of the same name is refused, whether the user or Captain asks for it, and so is Captain's
 * own name, so that "@Captain" means Captain.
 *
 * `except` is the agent being renamed. Keeping the name it has is no new name, and is not refused:
 * a user agent called "Captain" from before the name was reserved can still be edited.
 */
export function checkAgentName(
  agents: AgentStore,
  name: string,
  except?: string,
): void {
  const current = except === undefined ? undefined : agents.get(except);
  if (
    current !== undefined &&
    current.name.trim().toLowerCase() === name.trim().toLowerCase()
  )
    return;
  if (isCaptainName(name))
    throw new Error(
      `"${name.trim()}" is reserved for Captain; choose another name`,
    );
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
