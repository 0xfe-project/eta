/**
 * The product API: AXP's shapes over our data (REFACTOR.md §9, P2.4).
 *
 *   GET    /api/v1/chat                       the snapshot (groups, agents, active replies, cursor)
 *   GET    /api/v1/chat/stream?cursor=…       one SSE stream of product events
 *   GET    /api/v1/agents                     the agents
 *   POST   /api/v1/agents                     {name, description, model?, bundles?}
 *   PATCH  /api/v1/agents/{id}
 *   DELETE /api/v1/agents/{id}
 *
 * The existing web is the client and its types are generated from the control plane's document, so
 * this layer speaks that vocabulary; `compat/shapes.ts` does the translating and explains where
 * the two differ. Our own routes (`/agents`, `/groups`, `/sessions`) stay as they are: they are
 * the surface curl and the tests use, and keeping them separate is what stops a client's taste
 * from becoming our storage layout.
 *
 * One route is answered honestly rather than faked: `POST /api/v1/agents/{id}/restart` returns 501,
 * because nothing here runs in a container and there is nothing to restart.
 */
import type { KernelModels } from "@eta/core";
import type { Context } from "cordis";
import type { AgentStore } from "../agents/store";
import type { AxpGroup, AxpMessage, AxpSnapshot } from "../compat/shapes";
import type { GroupStore, MessageRecord } from "../groups/store";
import type { EventHub, EventTranslator } from "../http/events";
import type { PluginContext } from "../plugin-api";
import { publishAgentDeleted, publishAgentUpdated } from "../agents/events";
import { modelRejection } from "../agents/model-check";
import { toAgent, toGroup, toMessage } from "../compat/shapes";
import { errorResponse } from "../routes";

/**
 * How many messages one history page holds.
 *
 * The web reads pages newest-first and pages back through them, so what matters is that the cursor
 * it hands back (the seq of the oldest row it just read) resumes without a gap and without a
 * repeat. The size itself is ours to choose.
 */
const PAGE = 50;

export interface CompatPluginConfig {
  agents: AgentStore;
  groups: GroupStore;
  hub: EventHub;
  /** For the model check on write, exactly as the internal route does it. */
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

const asNames = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((name) => typeof name === "string")
    ? (value as string[])
    : undefined;

export const compatPlugin = {
  name: "compat",
  inject: ["routes"],
  apply(ctx: Context, config: CompatPluginConfig): void {
    const plugin = ctx as unknown as PluginContext;
    const { agents, groups, hub, models } = config;

    /** One group in the product's shape. */
    const groupShape = (groupId: string): AxpGroup | undefined => {
      const found = groups
        .list()
        .find((candidate) => candidate.group.id === groupId);
      if (found === undefined) return undefined;
      const last = groups.lastMessage(groupId);
      return toGroup({
        group: found.group,
        participants: found.participants,
        seq: groups.summary(groupId)?.seq ?? 0,
        preview: last?.text ?? "",
        lastMessageAt: last?.createdAt ?? null,
        agentName: (agentId) => agents.get(agentId)?.name ?? agentId,
      });
    };

    /** Every group, in the product's shape: what the sidebar reads. */
    const allGroups = (): AxpGroup[] =>
      groups
        .list()
        .map(({ group }) => groupShape(group.id))
        .filter((group): group is AxpGroup => group !== undefined)
        // Newest first: the sidebar shows the conversations that moved most recently.
        .sort((a, b) =>
          (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""),
        );

    /** The replies that are running now, across every group. */
    const activeReplies = (): AxpMessage[] => {
      const replies: AxpMessage[] = [];
      for (const { group } of groups.list()) {
        for (const message of groups.messages(group.id)) {
          if (message.authorKind === "agent" && message.status === "working") {
            replies.push(toMessage(message));
          }
        }
      }
      return replies;
    };

    /**
     * Our events in the product's vocabulary.
     *
     * Events the web has no word for (`session.created`, `session.turn`, `group.reply`) are
     * dropped rather than renamed: a frame the client cannot interpret is not information.
     */
    const translate: EventTranslator = (event) => {
      switch (event.type) {
        case "message.updated":
          return {
            name: "message.updated",
            data: {
              message: toMessage(
                (event.data as { message: MessageRecord }).message,
              ),
            },
          };
        case "group.updated": {
          // One group, not the whole list: this runs per event.
          const id = (event.data as { group: { id: string } }).group.id;
          const group = groupShape(id);
          return group === undefined
            ? undefined
            : { name: "group.updated", data: { group } };
        }
        case "agent.updated": {
          const record = (event.data as { agent: { id: string } }).agent;
          const agent = agents.get(record.id);
          return agent === undefined
            ? undefined
            : { name: "agent.updated", data: { agent: toAgent(agent) } };
        }
        case "agent.deleted":
          return {
            name: "agent.deleted",
            data: { agent_id: (event.data as { agentId: string }).agentId },
          };
        default:
          return undefined;
      }
    };

    const rejection = (raw: string): Response | undefined => {
      const problem = modelRejection(models, raw);
      if (problem === undefined) return undefined;
      return errorResponse(
        409,
        problem.code,
        problem.message,
        crypto.randomUUID(),
      );
    };

    plugin.effect(() =>
      plugin.routes.register("GET", "/api/v1/chat", () => {
        const snapshot: AxpSnapshot = {
          groups: allGroups(),
          agents: agents.list().map(toAgent),
          active_replies: activeReplies(),
          // Ask cards arrive with P2.6's ask channel; the field exists so the client's
          // shape is complete.
          interactions: [],
          // The hub's own sequence: what a client hands back to resume its stream.
          event_cursor: String(hub.sequence),
        };
        return Response.json(snapshot);
      }),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "GET",
        "/api/v1/groups/:group_id/messages",
        (request, params) => {
          const id = params.group_id ?? "";
          if (groups.get(id) === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_GROUP",
              `no group ${id}`,
              crypto.randomUUID(),
            );
          }
          // No cursor means "the newest page". A blank one is missing, not zero — `Number("")`
          // is 0, and reading it as a seq would filter the timeline down to nothing.
          const raw = new URL(request.url).searchParams.get("before");
          const before =
            raw === null || raw.trim() === "" ? undefined : Number(raw);
          if (before !== undefined && !Number.isFinite(before)) {
            return errorResponse(
              400,
              "BAD_CURSOR",
              `before=${raw} is not a cursor`,
              crypto.randomUUID(),
            );
          }
          const all = groups.messages(id);
          // Pages go back in time: the newest page first, then the one before it. The cursor is
          // the seq of the oldest row in the page just read, and the next page holds strictly
          // older rows — so nothing is skipped and nothing is sent twice.
          const older =
            before === undefined
              ? all
              : all.filter((message) => message.seq < before);
          const items = older.slice(Math.max(0, older.length - PAGE));
          return Response.json({
            items: items.map(toMessage),
            next_cursor:
              older.length > items.length ? String(items[0]!.seq) : null,
          });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register("GET", "/api/v1/chat/interactions", () =>
        // Ask cards are a session's ask channel, which is P2.6. The route exists now because
        // the web's history page queries it: an empty list is true, a 404 would be a lie
        // about what exists.
        Response.json({ interactions: [] }),
      ),
    );

    plugin.effect(() =>
      plugin.routes.register("GET", "/api/v1/chat/stream", (request) =>
        // The cursor, the replay, the heartbeat and the 410 for an expired cursor are the
        // hub's (P0.5); this surface only says what its events are called.
        hub.handle(request, { translate }),
      ),
    );

    plugin.effect(() =>
      plugin.routes.register("GET", "/api/v1/agents", () =>
        Response.json({ agents: agents.list().map(toAgent) }),
      ),
    );

    plugin.effect(() =>
      plugin.routes.register("POST", "/api/v1/agents", async (request) => {
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
          const rejected = rejection(model);
          if (rejected !== undefined) return rejected;
        }
        const record = agents.create({
          name,
          ...(model === undefined ? {} : { model }),
          ...(asString(body.description) === undefined
            ? {}
            : { instructions: asString(body.description)! }),
          ...(asNames(body.bundles) === undefined
            ? {}
            : { plugins: asNames(body.bundles)! }),
        });
        publishAgentUpdated(hub, record);
        return Response.json(toAgent(record), { status: 201 });
      }),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "PATCH",
        "/api/v1/agents/:id",
        async (request, params) => {
          const id = params.id ?? "";
          if (agents.get(id) === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_AGENT",
              `no agent ${id}`,
              crypto.randomUUID(),
            );
          }
          const body = await readJson(request);
          const model = asString(body.model);
          if (model !== undefined) {
            const rejected = rejection(model);
            if (rejected !== undefined) return rejected;
          }
          const record = agents.update(id, {
            ...(asString(body.name) === undefined
              ? {}
              : { name: asString(body.name)! }),
            ...(model === undefined ? {} : { model }),
            ...(asString(body.description) === undefined
              ? {}
              : { instructions: asString(body.description)! }),
            ...(asNames(body.bundles) === undefined
              ? {}
              : { plugins: asNames(body.bundles)! }),
          });
          if (record === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_AGENT",
              `no agent ${id}`,
              crypto.randomUUID(),
            );
          }
          publishAgentUpdated(hub, record);
          return Response.json(toAgent(record));
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "DELETE",
        "/api/v1/agents/:id",
        (_request, params) => {
          const id = params.id ?? "";
          if (!agents.remove(id)) {
            return errorResponse(
              404,
              "NO_SUCH_AGENT",
              `no agent ${id}`,
              crypto.randomUUID(),
            );
          }
          publishAgentDeleted(hub, id);
          return new Response(null, { status: 204 });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/api/v1/agents/:id/restart",
        (_request, params) => {
          const id = params.id ?? "";
          if (agents.get(id) === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_AGENT",
              `no agent ${id}`,
              crypto.randomUUID(),
            );
          }
          return errorResponse(
            501,
            "NOT_IMPLEMENTED",
            "this build has no containers to restart; an agent's sessions are opened on demand",
            crypto.randomUUID(),
          );
        },
      ),
    );
  },
};
