/**
 * The agents plugin: the register of what a conversation belongs to (REFACTOR.md §9, P0.8).
 *
 *   GET    /agents          what this host knows
 *   POST   /agents          {name, model?, instructions?, plugins?}
 *   GET    /agents/:id
 *   PATCH  /agents/:id      any subset of the four
 *   DELETE /agents/:id
 *
 * **An agent is not a session.** Nothing here opens one, and the sessions plugin never reads this
 * table: a group with three agents is three sessions and one timeline, and none of those is an
 * agent. What ties them together — the group's thread — is P2's table, and it will point at both.
 *
 * The model is validated when it is written, not when a turn starts: an agent naming a model no
 * provider serves would fail every message it ever sent, and that is better said at the write
 * (which is AXP's rule for the same field).
 */
import type { KernelModels } from "@eta/core";
import type { Context } from "cordis";
import type { AgentStore } from "../agents/store";
import type { GroupStore } from "../groups/store";
import type { PluginContext } from "../plugin-api";
import { formatModelId, parseModelId } from "@eta/server";
import { errorResponse } from "../routes";

export interface AgentsPluginConfig {
  agents: AgentStore;
  /** The one product rule that ties the two together: an agent has a private group. */
  groups: GroupStore;
  /** The model layer, for checking that a named model is one this host can actually reach. */
  models: KernelModels | undefined;
}

const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  try {
    const body = (await request.json()) as unknown;
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asPlugins = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((name) => typeof name === "string")
    ? (value as string[])
    : undefined;

export const agentsPlugin = {
  name: "agents",
  inject: ["routes"],
  apply(ctx: Context, config: AgentsPluginConfig): void {
    const plugin = ctx as unknown as PluginContext;
    const { agents, groups, models } = config;

    const notFound = (id: string): Response =>
      errorResponse(
        404,
        "NO_SUCH_AGENT",
        `no agent ${id}`,
        crypto.randomUUID(),
      );

    /**
     * `undefined` when the model is fine (or absent); a response to send back when it is not.
     * `provider:modelId` is the form; a bare id is read as the default provider, which this host
     * very likely does not serve — and that is an answer, not a guess.
     */
    const checkModel = (raw: string): Response | undefined => {
      const identity = parseModelId(raw);
      if (models?.getModel(identity.provider, identity.modelId) !== undefined)
        return undefined;
      return errorResponse(
        409,
        "MODEL_UNKNOWN",
        `no model ${formatModelId(identity)} is configured; use provider:modelId`,
        crypto.randomUUID(),
      );
    };

    plugin.effect(() =>
      plugin.routes.register("GET", "/agents", () =>
        Response.json({ agents: agents.list() }),
      ),
    );

    plugin.effect(() =>
      plugin.routes.register("POST", "/agents", async (request) => {
        const body = await readJson(request);
        const name = asString(body.name);
        if (name === undefined) {
          return errorResponse(
            400,
            "NO_NAME",
            "an agent needs a name",
            crypto.randomUUID(),
          );
        }
        const model = asString(body.model);
        if (model !== undefined) {
          const rejected = checkModel(model);
          if (rejected !== undefined) return rejected;
        }
        const agent = agents.create({
          name,
          ...(model === undefined ? {} : { model }),
          ...(asString(body.instructions) === undefined
            ? {}
            : { instructions: asString(body.instructions)! }),
          ...(asPlugins(body.plugins) === undefined
            ? {}
            : { plugins: asPlugins(body.plugins)! }),
        });
        // The agent's private group, made in the same breath: a conversation belongs to
        // something, and an agent nobody can open a conversation with is a row nobody reaches.
        groups.ensurePrivateGroup(agent.id, agent.name);
        return Response.json({ agent }, { status: 201 });
      }),
    );

    plugin.effect(() =>
      plugin.routes.register("GET", "/agents/:id", (_request, params) => {
        const agent = agents.get(params.id ?? "");
        return agent === undefined
          ? notFound(params.id ?? "")
          : Response.json({ agent });
      }),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "PATCH",
        "/agents/:id",
        async (request, params) => {
          const id = params.id ?? "";
          if (agents.get(id) === undefined) return notFound(id);
          const body = await readJson(request);
          const model = asString(body.model);
          if (model !== undefined) {
            const rejected = checkModel(model);
            if (rejected !== undefined) return rejected;
          }
          const agent = agents.update(id, {
            ...(asString(body.name) === undefined
              ? {}
              : { name: asString(body.name)! }),
            ...(model === undefined ? {} : { model }),
            ...(asString(body.instructions) === undefined
              ? {}
              : { instructions: asString(body.instructions)! }),
            ...(asPlugins(body.plugins) === undefined
              ? {}
              : { plugins: asPlugins(body.plugins)! }),
          });
          return agent === undefined ? notFound(id) : Response.json({ agent });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register("DELETE", "/agents/:id", (_request, params) => {
        const id = params.id ?? "";
        // A hard delete today. AXP *hid* agents because tasks and messages pointed at them;
        // nothing points at one yet, so there is nothing to keep the row for — when P3 gives an
        // agent references, this becomes a hide, and that is a decision to make then.
        // The private group first: deleting the agent cascades its participant rows away, and
        // the group would then be an empty room nobody can find.
        groups.removePrivateGroupsOf(id);
        if (!agents.remove(id)) return notFound(id);
        return new Response(null, { status: 204 });
      }),
    );
  },
};
