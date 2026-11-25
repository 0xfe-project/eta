import type {
  AgentRuntime,
  AgentRuntimeAccount,
  AgentRuntimeInfo,
  AgentView,
  ModelThinking,
  ThinkingLevel,
} from "@eta/client-contracts";
import type { CallFrame } from "@eta/client-wire-proto";
/**
 * The `agents` plugin: the register of who can be talked to.
 *
 * An agent comes with a workspace, a directory of its own under the data directory that is also a
 * project (kind `agent_home`, owner: the agent). It is talked to in groups.
 *
 * Deleting an agent is mostly clearing what pointed at it. The foreign keys take it out of the
 * stewards and the memberships; what is left is the replies it had running (stopped), whatever a
 * kind of conversation keeps of its own (`ConversationPolicy.onAgentDeleted`) and its workspace
 * (left on disk, because what an agent wrote there is not ours to throw away).
 */
import type { Database } from "bun:sqlite";
import type { Engine } from "../conversations/engine";
import type { ConversationPolicies } from "../conversations/policy";
import type { Timeline } from "../conversations/timeline";
import type { MachineStore } from "../machines/store";
import type { Plugins } from "../plugins/service";
import type { ProjectStore } from "../projects/store";
import type { AgentCreateDeps } from "./create";
import type { AgentRecord, AgentStore } from "./store";
import {
  agentThinking,
  isAgentRuntime,
  levelSupport,
} from "@eta/client-contracts";
import { THINKING_LEVELS } from "@eta/core";
import { Args, productPlugin, publish } from "../wire";
import {
  checkAgentName,
  checkMachine,
  checkPlugins,
  createAgent,
} from "./create";
import { homeOf } from "./home";
import { checkModel, requireModel } from "./model";
import { agentHome } from "./store";

export interface AgentsDeps {
  dataDir: string;
  db: Database;
  agents: AgentStore;
  machines: MachineStore;
  projects: ProjectStore;
  /** Each kind of conversation is told when an agent is renamed or deleted. */
  policies: ConversationPolicies;
  timeline: Timeline;
  engine: Engine;
  plugins: Plugins;
  changed: (conversations?: readonly string[] | "all") => void;
  /** The external runtimes this host has, with their models; absent when it runs none. */
  runtimes?: ((fresh: boolean) => Promise<AgentRuntimeInfo[]>) | undefined;
  /** The external runtimes of a daemon machine, asked over its link (which has to be up). */
  machineRuntimes?:
    | ((machineId: string, fresh: boolean) => Promise<AgentRuntimeInfo[]>)
    | undefined;
  /** A runtime's sign-in and plan usage on this host; undefined for a runtime it does not have. */
  runtimeAccount?:
    | ((runtime: string) => Promise<AgentRuntimeAccount | undefined>)
    | undefined;
  /** The same on a daemon machine, asked over its link. */
  machineRuntimeAccount?:
    | ((machineId: string, runtime: string) => Promise<AgentRuntimeAccount>)
    | undefined;
  /** Append prompt history for user edits as well as Captain edits. */
  capturePrompt?: AgentCreateDeps["capturePrompt"];
  /**
   * The levels an eta model takes, as the model layer sessions run on reads its declaration
   * (`thinkingLevelsFor`); undefined for a model it cannot resolve.
   */
  modelLevels?: ((model: string) => ThinkingLevel[] | undefined) | undefined;
}

/** What a client may draw an avatar from: an agent's id is one, and so is a short random string. */
const AVATAR_SEED = /^[\w-]{1,64}$/;

export function agentsPlugin(deps: AgentsDeps, applied: () => void) {
  const { agents, projects, machines, timeline, plugins } = deps;

  const viewOf = (
    agent: AgentRecord,
    statuses = timeline.agentStatuses(),
  ): AgentView => {
    const home = agentHome(deps.dataDir, agent.id);
    const project = homeOf(deps, agent);
    return {
      id: agent.id,
      name: agent.name,
      instructions: agent.instructions,
      persona: agent.persona,
      runtime: agent.runtime,
      model: agent.model,
      thinkingLevel: agent.thinkingLevel,
      machineId: agent.machineId,
      plugins: plugins.rows.enabled(agent.id),
      skippedPlugins: plugins.skipped(agent.id),
      systemRole: agent.systemRole,
      avatarSeed: agent.avatarSeed,
      avatarSeeds: agent.avatarSeeds,
      home,
      homeProjectId: project?.id ?? "",
      status: statuses.get(agent.id) ?? "idle",
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    };
  };

  const existing = (id: string): AgentRecord => {
    const agent = agents.get(id);
    if (agent === undefined) throw new Error(`no such agent: ${id}`);
    return agent;
  };

  return productPlugin(
    "agents",
    (ctx) => {
      const { wire } = ctx;
      const offs = [
        publish(
          wire,
          "agents",
          {
            list: () => {
              const statuses = timeline.agentStatuses();
              return agents.list().map((agent) => viewOf(agent, statuses));
            },
          },
          { eager: true },
        ),

        wire.handle("agents", "create", async (call) => {
          const fields = fieldsOf(call, true);
          if (
            fields.thinkingLevel !== undefined &&
            fields.thinkingLevel !== null
          )
            refuseLevel(
              fields.thinkingLevel,
              fields.model ?? null,
              await thinkingOf(
                fields.runtime ?? "eta",
                fields.model ?? null,
                fields.machineId ?? null,
              ),
            );
          const { agent } = await createAgent(
            deps,
            { ...fields, name: fields.name! },
            null,
          );
          deps.changed();
          return { result: { agent: viewOf(existing(agent.id)) } };
        }),

        wire.handle("agents", "update", async (call) => {
          const args = new Args(call);
          const id = args.string("agentId");
          const before = existing(id);
          if (before.systemRole === "captain")
            throw new Error(
              "the Captain is managed through the captain target",
            );
          const fields = fieldsOf(call, false);
          const avatarSeed = args.optionalString("avatarSeed");
          if (avatarSeed !== undefined && !AVATAR_SEED.test(avatarSeed))
            throw new Error(
              "avatarSeed must be 1 to 64 letters, digits, - or _",
            );
          const moved =
            fields.runtime !== undefined && fields.runtime !== before.runtime;
          // Another runtime's names mean nothing on this one: a move that names no model clears it.
          if (moved && fields.model === undefined) fields.model = null;
          // Clearing the model of an agent on eta's own loop, or moving one there without a model,
          // is refused; an edit that leaves the model alone (its plugins, say) is not held up by it.
          (fields.model !== undefined || moved ? requireModel : checkModel)(
            fields.runtime ?? before.runtime,
            fields.model === undefined ? before.model : fields.model,
          );
          if (fields.name !== undefined)
            checkAgentName(agents, fields.name, id);
          checkMachine(machines, fields.machineId);
          checkPlugins(plugins, id, fields.plugins);
          const thinkingCleared = await settleLevel(before, fields);
          const { agent, sessions } = deps.engine.saveAgent(before, {
            ...fields,
            ...(avatarSeed === undefined ? {} : { avatarSeed }),
          });
          if (fields.plugins !== undefined)
            plugins.rows.setEnabled(id, fields.plugins);
          if (agent.instructions !== before.instructions)
            deps.capturePrompt?.({
              agentId: id,
              kind: "instructions",
              content: agent.instructions,
              actorAgentId: null,
            });
          if (agent.persona !== before.persona)
            deps.capturePrompt?.({
              agentId: id,
              kind: "persona",
              content: agent.persona,
              actorAgentId: null,
            });
          if (agent.name !== before.name) renameHome(agent);
          await deps.engine.applySettings(sessions);
          deps.changed("all");
          return {
            result: {
              agent: viewOf(agent),
              ...(thinkingCleared === undefined ? {} : { thinkingCleared }),
            },
          };
        }),

        wire.handle("agents", "delete", (call) => {
          const id = new Args(call).string("agentId");
          const agent = existing(id);
          if (agent.systemRole === "captain")
            throw new Error(
              "the Captain cannot be deleted as an ordinary agent",
            );
          // Running replies first: they would otherwise outlive the agent that is writing them.
          deps.engine.stopAgent(id);
          const home = homeOf(deps, agent);
          deps.db.transaction(() => {
            deps.policies.agentDeleted(agent);
            if (home !== undefined)
              projects.update(home.id, { archived: true });
            // Stewards and memberships go with the row (ON DELETE SET NULL / CASCADE).
            agents.remove(agent.id);
          })();
          deps.changed("all");
          return { result: { agentId: id } };
        }),

        wire.handle("agents", "runtimes", async (call) => {
          const fresh =
            (call.args as { fresh?: unknown } | undefined)?.fresh === true;
          const machineId = new Args(call).optionalString("machineId");
          const machine =
            machineId === undefined ? undefined : machines.get(machineId);
          if (machineId !== undefined && machine === undefined)
            throw new Error(`no such machine: ${machineId}`);
          // The primary's own, unless another machine is asked about.
          if (machine === undefined || machine.kind === "primary")
            return {
              result: { runtimes: (await deps.runtimes?.(fresh)) ?? [] },
            };
          if (machine.status !== "online" || deps.machineRuntimes === undefined)
            throw new Error(`${machine.name} is not online`);
          return {
            result: {
              runtimes: await deps.machineRuntimes(machine.id, fresh),
            },
          };
        }),

        wire.handle("agents", "runtimeAccount", async (call) => {
          const args = new Args(call);
          const runtime = args.string("runtime");
          const machineId = args.optionalString("machineId");
          const machine =
            machineId === undefined ? undefined : machines.get(machineId);
          if (machineId !== undefined && machine === undefined)
            throw new Error(`no such machine: ${machineId}`);
          if (machine === undefined || machine.kind === "primary") {
            const account = await deps.runtimeAccount?.(runtime);
            if (account === undefined)
              throw new Error(`no such runtime here: ${runtime}`);
            return { result: { account } };
          }
          if (
            machine.status !== "online" ||
            deps.machineRuntimeAccount === undefined
          )
            throw new Error(`${machine.name} is not online`);
          return {
            result: {
              account: await deps.machineRuntimeAccount(machine.id, runtime),
            },
          };
        }),
      ];
      return () => {
        for (const off of offs.splice(0)) off();
      };
    },
    applied,
  );

  /**
   * The levels an agent on this runtime, model and machine can be set to, as far as the host
   * knows them: an eta model's from the model layer, an external runtime's from the machine's
   * runtime list. A machine that cannot be asked (offline, failing) leaves them unknown.
   */
  async function thinkingOf(
    runtime: AgentRuntime,
    model: string | null,
    machineId: string | null,
  ): Promise<ModelThinking> {
    if (runtime === "eta") {
      const levels = model === null ? undefined : deps.modelLevels?.(model);
      return levels === undefined
        ? agentThinking(runtime, null, {})
        : { basis: "declared", levels };
    }
    const machine = machineId === null ? undefined : machines.get(machineId);
    try {
      const runtimes =
        machine === undefined || machine.kind === "primary"
          ? await deps.runtimes?.(false)
          : machine.status === "online"
            ? await deps.machineRuntimes?.(machine.id, false)
            : undefined;
      return agentThinking(runtime, model, { runtimes });
    } catch {
      return agentThinking(runtime, model, {});
    }
  }

  /**
   * An update's level, settled against the model the agent ends up on. A level the call names
   * that the model does not take is refused; a level the agent kept that its new model does not
   * take is cleared, and said back (`thinkingCleared`). Nothing is checked when neither the level
   * nor where the agent runs changes.
   */
  async function settleLevel(
    before: AgentRecord,
    fields: ReturnType<typeof fieldsOf>,
  ): Promise<ThinkingLevel | undefined> {
    const runtime = fields.runtime ?? before.runtime;
    const model = fields.model === undefined ? before.model : fields.model;
    const machineId =
      fields.machineId === undefined ? before.machineId : fields.machineId;
    if (fields.thinkingLevel !== undefined) {
      if (fields.thinkingLevel !== null)
        refuseLevel(
          fields.thinkingLevel,
          model,
          await thinkingOf(runtime, model, machineId),
        );
      return undefined;
    }
    const kept = before.thinkingLevel;
    const moved =
      runtime !== before.runtime ||
      model !== before.model ||
      machineId !== before.machineId;
    if (kept === null || !moved) return undefined;
    const thinking = await thinkingOf(runtime, model, machineId);
    if (levelSupport(thinking, kept) !== "unsupported") return undefined;
    fields.thinkingLevel = null;
    return kept;
  }

  /** The home project carries the agent's name, and so may conversations; a rename follows them. */
  function renameHome(agent: AgentRecord): void {
    const home = homeOf(deps, agent);
    if (home === undefined) return;
    projects.update(home.id, { name: agent.name });
    deps.policies.agentRenamed(agent);
  }
}

/** Refuse a level the model is known not to take, naming the ones it does. */
function refuseLevel(
  level: ThinkingLevel,
  model: string | null,
  thinking: ModelThinking,
): void {
  if (levelSupport(thinking, level) !== "unsupported") return;
  const name = model ?? "the runtime's default model";
  throw new Error(
    thinking.levels.length === 0
      ? `${name} takes no thinking level: leave it on the model's default`
      : `${name} does not take thinking level ${level}; it takes ${thinking.levels.join(", ")}`,
  );
}

/** The fields of an agent a call carries; `create` needs a name, `update` takes what is sent. */
function fieldsOf(
  call: CallFrame,
  create: boolean,
): {
  name?: string;
  instructions?: string;
  persona?: string;
  runtime?: AgentRuntime;
  model?: string | null;
  thinkingLevel?: ThinkingLevel | null;
  machineId?: string | null;
  plugins?: string[];
} {
  const args = new Args(call);
  const { plugins } = (call.args ?? {}) as { plugins?: unknown };
  if (
    plugins !== undefined &&
    (!Array.isArray(plugins) ||
      plugins.some((name) => typeof name !== "string"))
  )
    throw new TypeError("plugins must be a list of names");
  const runtime = args.optionalString("runtime");
  if (runtime !== undefined && !isAgentRuntime(runtime))
    throw new Error(`unknown runtime: ${runtime}`);
  const name = create ? args.string("name") : args.optionalString("name");
  if (name !== undefined && name.trim() === "")
    throw new Error("an agent needs a name");
  const model = args.nullableString("model");
  const level = args.nullableString("thinkingLevel");
  if (typeof level === "string" && !THINKING_LEVELS.includes(level as never))
    throw new Error(`unknown thinking level: ${level}`);
  const machineId = args.nullableString("machineId");
  const instructions = args.optionalString("instructions");
  const persona = args.optionalString("persona");
  return {
    ...(name === undefined ? {} : { name: name.trim() }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(persona === undefined ? {} : { persona }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(model === undefined ? {} : { model: model === "" ? null : model }),
    ...(level === undefined
      ? {}
      : { thinkingLevel: level === "" ? null : (level as ThinkingLevel) }),
    ...(machineId === undefined
      ? {}
      : { machineId: machineId === "" ? null : machineId }),
    ...(plugins === undefined ? {} : { plugins: plugins as string[] }),
  };
}
