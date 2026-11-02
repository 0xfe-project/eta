import type {
  AgentRuntime,
  AgentRuntimeInfo,
  AgentView,
  ThinkingLevel,
} from "@eta/client-contracts";
import type { CallFrame } from "@eta/client-wire-proto";
/**
 * The `agents` plugin: the register of who can be talked to.
 *
 * An agent comes with a workspace, a directory of its own under the data directory that is also a
 * project (kind `agent_home`, steward: the agent), and with a way to talk to it alone: the private
 * chat in that project. The chat is made the first time it is asked for (`direct`) and found every
 * time after.
 *
 * Deleting an agent is mostly clearing what pointed at it. The foreign keys take it out of the
 * stewards and the memberships; what is left is the replies it had running (stopped), the private
 * chats that lose their only member (archived) and its workspace (left on disk, because what an
 * agent wrote there is not ours to throw away).
 */
import type { Database } from "bun:sqlite";
import type { Engine } from "../conversations/engine";
import type { ConversationStore } from "../conversations/store";
import type { Timeline } from "../conversations/timeline";
import type { MachineStore } from "../machines/store";
import type { ProjectStore } from "../projects/store";
import type { AgentRecord, AgentStore } from "./store";
import { mkdir, rm } from "node:fs/promises";
import { AGENT_RUNTIMES } from "@eta/client-contracts";
import { THINKING_LEVELS } from "@eta/core";
import { summaryOf } from "../conversations/views";
import { Args, productPlugin, publish } from "../wire";
import { agentHome } from "./store";

export interface AgentsDeps {
  dataDir: string;
  db: Database;
  agents: AgentStore;
  machines: MachineStore;
  projects: ProjectStore;
  conversations: ConversationStore;
  timeline: Timeline;
  engine: Engine;
  changed: (conversations?: readonly string[] | "all") => void;
  /** A conversation exists now: its target has to be published. */
  created: (conversationId: string) => void;
  /** An agent is gone: whatever it was given outside the database goes with it. */
  removed: (agentId: string) => void;
  /** The external runtimes this host has, with their models; absent when it runs none. */
  runtimes?: ((fresh: boolean) => Promise<AgentRuntimeInfo[]>) | undefined;
}

export function agentsPlugin(deps: AgentsDeps, applied: () => void) {
  const { agents, projects, machines, conversations, timeline } = deps;

  const viewOf = (
    agent: AgentRecord,
    statuses = timeline.agentStatuses(),
  ): AgentView => {
    const home = agentHome(deps.dataDir, agent.id);
    const primary = machines.primary();
    const project =
      primary === undefined ? undefined : projects.byPath(primary.id, home);
    return {
      id: agent.id,
      name: agent.name,
      instructions: agent.instructions,
      persona: agent.persona,
      runtime: agent.runtime,
      model: agent.model,
      thinkingLevel: agent.thinkingLevel,
      bundles: agent.bundles,
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
          checkModel(fields.runtime ?? "eta", fields.model ?? null);
          const primary = machines.primary();
          if (primary === undefined)
            throw new Error("this host has no machine");
          const id = crypto.randomUUID();
          const home = agentHome(deps.dataDir, id);
          await mkdir(home, { recursive: true });
          try {
            // The agent and its workspace appear together or not at all.
            deps.db.transaction(() => {
              agents.create({ ...fields, name: fields.name! }, id);
              projects.create({
                machineId: primary.id,
                path: home,
                name: fields.name!,
                kind: "agent_home",
                stewardId: id,
              });
            })();
          } catch (error) {
            await rm(home, { recursive: true, force: true });
            throw error;
          }
          deps.changed();
          return { result: { agent: viewOf(existing(id)) } };
        }),

        wire.handle("agents", "update", async (call) => {
          const args = new Args(call);
          const id = args.string("agentId");
          const before = existing(id);
          const fields = fieldsOf(call, false);
          const moved =
            fields.runtime !== undefined && fields.runtime !== before.runtime;
          // Another runtime's names mean nothing on this one: a move that names no model clears it.
          if (moved && fields.model === undefined) fields.model = null;
          checkModel(
            fields.runtime ?? before.runtime,
            fields.model === undefined ? before.model : fields.model,
          );
          const agent = agents.update(id, fields)!;
          if (agent.name !== before.name) renameHome(agent);
          // The model and thinking level belong to a session once it exists; an edit of the agent
          // is the one thing that overrides what the user chose there. An agent that moved to
          // another runtime gets new sessions instead (`places.ts`), so there is nothing to set.
          if (!moved)
            await deps.engine.applySettings(id, {
              ...(agent.model !== null && agent.model !== before.model
                ? { model: agent.model }
                : {}),
              ...(agent.thinkingLevel !== null &&
              agent.thinkingLevel !== before.thinkingLevel
                ? { thinkingLevel: agent.thinkingLevel }
                : {}),
            });
          deps.changed("all");
          return { result: { agent: viewOf(agent) } };
        }),

        wire.handle("agents", "delete", (call) => {
          const id = new Args(call).string("agentId");
          const agent = existing(id);
          // Running replies first: they would otherwise outlive the agent that is writing them.
          deps.engine.stopAgent(id);
          const primary = machines.primary();
          const home =
            primary === undefined
              ? undefined
              : projects.byPath(primary.id, agentHome(deps.dataDir, id));
          deps.db.transaction(() => {
            conversations.archiveDirectOf(id);
            if (home !== undefined)
              projects.update(home.id, { archived: true });
            // Stewards and memberships go with the row (ON DELETE SET NULL / CASCADE).
            agents.remove(agent.id);
          })();
          deps.removed(id);
          deps.changed("all");
          return { result: { agentId: id } };
        }),

        wire.handle("agents", "runtimes", async (call) => {
          const fresh =
            (call.args as { fresh?: unknown } | undefined)?.fresh === true;
          return { result: { runtimes: (await deps.runtimes?.(fresh)) ?? [] } };
        }),

        wire.handle("agents", "direct", (call) => {
          const agent = existing(new Args(call).string("agentId"));
          const primary = machines.primary();
          const home =
            primary === undefined
              ? undefined
              : projects.byPath(primary.id, agentHome(deps.dataDir, agent.id));
          if (home === undefined)
            throw new Error(`${agent.name} has no workspace`);
          // Asking for the chat is asking to talk: a private chat that was put away comes back.
          let conversation = conversations.directOf(home.id, agent.id);
          if (conversation === undefined) {
            conversation = conversations.create({
              projectId: home.id,
              kind: "direct",
              name: agent.name,
              agentIds: [agent.id],
            });
            deps.created(conversation.id);
          } else if (conversation.archived) {
            conversation = conversations.update(conversation.id, {
              archived: false,
            })!;
          }
          deps.changed([conversation.id]);
          return {
            result: {
              conversation: summaryOf(
                { conversations, projects, timeline },
                conversation,
              ),
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

  /** The home project and the private chats carry the agent's name; a rename follows them. */
  function renameHome(agent: AgentRecord): void {
    const primary = machines.primary();
    const home =
      primary === undefined
        ? undefined
        : projects.byPath(primary.id, agentHome(deps.dataDir, agent.id));
    if (home === undefined) return;
    projects.update(home.id, { name: agent.name });
    conversations.renameDirect(home.id, agent.name);
  }
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
  bundles?: string[];
} {
  const args = new Args(call);
  const runtime = args.optionalString("runtime");
  if (runtime !== undefined && !AGENT_RUNTIMES.includes(runtime as never))
    throw new Error(`unknown runtime: ${runtime}`);
  const name = create ? args.string("name") : args.optionalString("name");
  if (name !== undefined && name.trim() === "")
    throw new Error("an agent needs a name");
  const model = args.nullableString("model");
  if (typeof model === "string" && !model.includes(":"))
    throw new Error("model must be provider:modelId");
  const level = args.nullableString("thinkingLevel");
  if (typeof level === "string" && !THINKING_LEVELS.includes(level as never))
    throw new Error(`unknown thinking level: ${level}`);
  const instructions = args.optionalString("instructions");
  const persona = args.optionalString("persona");
  const bundles = (call.args as { bundles?: unknown } | undefined)?.bundles;
  if (
    bundles !== undefined &&
    (!Array.isArray(bundles) ||
      !bundles.every(
        (name) =>
          typeof name === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(name),
      ))
  )
    throw new TypeError(
      `${call.target}.${call.action}: bundles must be a list of bundle names`,
    );
  return {
    ...(bundles === undefined
      ? {}
      : { bundles: [...new Set(bundles as string[])] }),
    ...(name === undefined ? {} : { name: name.trim() }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(persona === undefined ? {} : { persona }),
    ...(runtime === undefined ? {} : { runtime: runtime as AgentRuntime }),
    ...(model === undefined ? {} : { model: model === "" ? null : model }),
    ...(level === undefined
      ? {}
      : { thinkingLevel: level === "" ? null : (level as ThinkingLevel) }),
  };
}

/**
 * An external runtime's model is one of its own: `runtime:modelId`. An eta model on such an agent
 * (or the other way round) is a model nobody would run.
 */
function checkModel(runtime: AgentRuntime, model: string | null): void {
  if (model === null) return;
  const provider = model.slice(0, model.indexOf(":"));
  if (runtime !== "eta" && provider !== runtime)
    throw new Error(`a ${runtime} agent runs ${runtime}:<model>, not ${model}`);
}
