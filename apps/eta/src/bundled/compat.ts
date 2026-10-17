/**
 * The product API: AXP's shapes over our data (REFACTOR.md §9, P2.4).
 *
 *   GET    /api/v1/openapi.json               this surface's own contract (P2.5)
 *   POST   /api/v1/groups                     create a group (cwd included)
 *   PATCH  /api/v1/groups/{id}                rename, goal, folder
 *   GET    /api/v1/chat                       the snapshot (groups, agents, active replies, cursor)
 *   POST   /api/v1/groups                     create a group (cwd included)
 *   PATCH  /api/v1/groups/{id}                rename, goal, folder
 *   GET    /api/v1/chat/stream?cursor=…       one SSE stream of product events
 *   POST   /api/v1/chat/messages              send a message: a row, and joined by mode
 *   POST   /api/v1/chat/messages/{id}/stop    stop the run behind a reply (P2.6)
 *   POST   /api/v1/groups                     create a group (cwd included)
 *   PATCH  /api/v1/groups/{id}                rename, goal, folder
 *   GET    /api/v1/chat/interactions           the confirmation cards (P2.6)
 *   POST   /api/v1/chat/interactions/{id}/answer  the user's choice, back into the run
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
import type { WakeRunner } from "../groups/runner";
import type { GroupStore, MessageRecord } from "../groups/store";
import type { EventHub, EventTranslator } from "../http/events";
import type {
  InteractionRecord,
  InteractionStore,
} from "../interactions/store";
import type { PluginContext } from "../plugin-api";
import { publishAgentDeleted, publishAgentUpdated } from "../agents/events";
import { modelRejection } from "../agents/model-check";
import { productDocument } from "../compat/openapi";
import { toAgent, toGroup, toInteraction, toMessage } from "../compat/shapes";
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
  /** Stopping a reply is a run's business, so this layer asks the runner that owns it. */
  runner: WakeRunner;
  /** The confirmation cards, for reading. */
  interactions: InteractionStore;
  /** The bridge, for answering one: the half that reaches the run that is waiting. */
  ask: {
    answer: (
      id: string,
      value: string,
    ) => Promise<InteractionRecord | undefined>;
  };
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

const asStrings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;

const asNames = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((name) => typeof name === "string")
    ? (value as string[])
    : undefined;

/**
 * The text of a send.
 *
 * `undefined` means "there was text you did not write", `null` means "a part this build cannot
 * carry yet" — the difference matters, because one is a bad request and the other is honest.
 */
function textOfParts(parts: unknown): string | undefined | null {
  if (!Array.isArray(parts)) return undefined;
  const text: string[] = [];
  for (const part of parts) {
    if (typeof part !== "object" || part === null) return undefined;
    const type = (part as { type?: unknown }).type;
    if (type === "text") {
      const body = (part as { text?: unknown }).text;
      if (typeof body !== "string") return undefined;
      text.push(body);
      continue;
    }
    // Attachments: the web uploads to `/attachments` and sends the id back. There is no attachment
    // store here yet, and a message that quietly dropped a file would be worse than a refusal.
    return null;
  }
  return text.join("");
}

export const compatPlugin = {
  name: "compat",
  inject: ["routes"],
  apply(ctx: Context, config: CompatPluginConfig): void {
    const plugin = ctx as unknown as PluginContext;
    const { agents, ask, groups, hub, interactions, models, runner } = config;

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
        case "interaction.updated":
          return {
            name: "interaction.updated",
            data: {
              interaction: toInteraction(
                (event.data as { interaction: InteractionRecord }).interaction,
              ),
            },
          };
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
      // The document the web generates its client from (P2.5). Served here rather than shipped as
      // a file, so what a client reads is what this process actually answers.
      plugin.routes.register("GET", "/api/v1/openapi.json", () =>
        Response.json(productDocument()),
      ),
    );

    plugin.effect(() =>
      plugin.routes.register("GET", "/api/v1/chat", () => {
        const snapshot: AxpSnapshot = {
          groups: allGroups(),
          agents: agents.list().map(toAgent),
          active_replies: activeReplies(),
          // The cards still waiting: questions the user has not answered yet.
          interactions: interactions.pending().map(toInteraction),
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

    // Creating and renaming a group. The web's dialog has always called these two, and the host
    // answered neither: a group could only be made through the legacy `/groups` surface, which is
    // not what a browser speaks. Same body, same shape back as the snapshot's groups.
    plugin.effect(() =>
      plugin.routes.register("POST", "/api/v1/groups", async (request) => {
        const body = await readJson(request);
        const name = asString(body.name);
        if (name === undefined || name.trim().length === 0) {
          return errorResponse(
            400,
            "NO_NAME",
            "群需要一个名字。",
            crypto.randomUUID(),
          );
        }
        const members =
          asStrings(body.members) ?? asStrings(body.agentIds) ?? [];
        for (const agentId of members) {
          if (agents.get(agentId) === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_AGENT",
              `no agent ${agentId}`,
              crypto.randomUUID(),
            );
          }
        }
        const goal = asString(body.goal);
        // Omitted, not empty: a group with no folder says so, and the store is the one place that
        // decides what "not said" means.
        const cwd = asString(body.cwd);
        const created = groups.create({
          name: name.trim(),
          ...(goal === undefined ? {} : { goal }),
          ...(cwd === undefined ? {} : { cwd }),
          agentIds: members,
        });
        // The sidebar in every open tab learns about it the same way it learns about a new
        // message: an event on the hub, not a response only this caller sees.
        hub.publish("group.updated", { group: created.group });
        const group = groupShape(created.group.id);
        return group === undefined
          ? errorResponse(
              500,
              "NO_GROUP",
              "群刚建好就找不到了。",
              crypto.randomUUID(),
            )
          : Response.json(group, { status: 201 });
      }),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "PATCH",
        "/api/v1/groups/:group_id",
        async (request, params) => {
          const id = params.group_id ?? "";
          if (groups.get(id) === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_GROUP",
              `no group ${id}`,
              crypto.randomUUID(),
            );
          }
          const body = await readJson(request);
          const name = asString(body.name);
          const goal = asString(body.goal);
          const decided = asString(body.decided);
          const cwd = asString(body.cwd);
          groups.update(id, {
            ...(name === undefined ? {} : { name }),
            ...(goal === undefined ? {} : { goal }),
            ...(decided === undefined ? {} : { decided }),
            ...(cwd === undefined ? {} : { cwd }),
          });
          hub.publish("group.updated", { group: groups.get(id)!.group });
          const group = groupShape(id);
          return group === undefined
            ? errorResponse(
                404,
                "NO_SUCH_GROUP",
                `no group ${id}`,
                crypto.randomUUID(),
              )
            : Response.json(group);
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "PUT",
        "/api/v1/groups/:group_id/members/:agent_id",
        async (request, params) => {
          const groupId = params.group_id ?? "";
          const agentId = params.agent_id ?? "";
          const body = await readJson(request);
          const member = body.member === true;
          const found = groups.get(groupId);
          if (found === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_GROUP",
              `no group ${groupId}`,
              crypto.randomUUID(),
            );
          }
          if (found.group.private) {
            return errorResponse(
              409,
              "DIRECT_GROUP",
              "私聊成员不能修改，请新建群。",
              crypto.randomUUID(),
            );
          }
          if (agents.get(agentId) === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_AGENT",
              `no agent ${agentId}`,
              crypto.randomUUID(),
            );
          }
          if (!member) {
            // A group keeps at least one member: an empty group is a conversation with nobody to
            // talk to.
            const remaining = found.participants.filter(
              (participant) => participant.agentId !== agentId,
            );
            if (remaining.length === 0) {
              return errorResponse(
                409,
                "LAST_MEMBER",
                "群里至少保留一个智能体。",
                crypto.randomUUID(),
              );
            }
            // Stop what the leaving member was saying, so nothing replies into a group it is no
            // longer in.
            for (const message of groups.messages(groupId)) {
              if (
                message.authorAgentId === agentId &&
                (message.status === "working" ||
                  message.status === "waiting_for_input")
              ) {
                await runner.stop(message.id);
              }
            }
            groups.removeParticipant(groupId, agentId);
          } else {
            groups.addParticipant(groupId, agentId);
          }
          // A line in the timeline: who joined, who left. A group whose membership changed silently
          // is a group whose history lies about who was there.
          const name = agents.get(agentId)?.name ?? agentId;
          groups.append({
            groupId,
            kind: "system",
            text: member ? `${name}加入了群` : `${name}离开了群`,
          });
          const group = groupShape(groupId);
          return group === undefined
            ? errorResponse(
                404,
                "NO_SUCH_GROUP",
                `no group ${groupId}`,
                crypto.randomUUID(),
              )
            : Response.json(group);
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/api/v1/groups/:group_id/read",
        async (request, params) => {
          const groupId = params.group_id ?? "";
          const body = await readJson(request);
          const seq = Number(body.seq);
          if (!Number.isFinite(seq) || seq < 0) {
            return errorResponse(
              422,
              "VALIDATION_ERROR",
              "seq must be a number ≥ 0",
              crypto.randomUUID(),
            );
          }
          const read = groups.markRead(groupId, Math.trunc(seq));
          if (read === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_GROUP",
              `no group ${groupId}`,
              crypto.randomUUID(),
            );
          }
          const group = groupShape(groupId);
          return group === undefined
            ? errorResponse(
                404,
                "NO_SUCH_GROUP",
                `no group ${groupId}`,
                crypto.randomUUID(),
              )
            : Response.json(group);
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/api/v1/groups/:group_id/stop",
        async (_request, params) => {
          const groupId = params.group_id ?? "";
          if (groups.get(groupId) === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_GROUP",
              `no group ${groupId}`,
              crypto.randomUUID(),
            );
          }
          // Everything this group is saying, stopped: a group-wide "quiet" rather than hunting reply
          // buttons one at a time.
          for (const message of groups.messages(groupId)) {
            if (
              message.authorKind === "agent" &&
              (message.status === "working" ||
                message.status === "waiting_for_input" ||
                message.status === "stopping")
            ) {
              await runner.stop(message.id);
            }
          }
          return new Response(null, { status: 204 });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/api/v1/chat/messages",
        async (request) => {
          const body = await readJson(request);
          const groupId = asString(body.group_id);
          if (groupId === undefined) {
            return errorResponse(
              400,
              "NO_GROUP",
              "a message needs a group_id",
              crypto.randomUUID(),
            );
          }
          const text = textOfParts(body.parts);
          if (text === null) {
            return errorResponse(
              501,
              "NOT_IMPLEMENTED",
              "attachments are not carried yet; send text only",
              crypto.randomUUID(),
            );
          }
          if (text === undefined || text.length === 0) {
            return errorResponse(
              400,
              "NO_TEXT",
              "a message needs text",
              crypto.randomUUID(),
            );
          }
          const sent = await runner.send({
            groupId,
            text,
            mentions: asNames(body.mentions) ?? [],
            mode: body.mode === "steer" ? "steer" : "queue",
            ...(asString(body.id) === undefined
              ? {}
              : { id: asString(body.id)! }),
          });
          if (sent === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_GROUP",
              `no group ${groupId}`,
              crypto.randomUUID(),
            );
          }
          // The product's answer: the message, and the replies that are already on their way.
          return Response.json(
            {
              message: toMessage(sent.message),
              replies: sent.replies.map(toMessage),
            },
            { status: 201 },
          );
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/api/v1/chat/interactions/:interaction_id/answer",
        async (request, params) => {
          const id = params.interaction_id ?? "";
          const body = await readJson(request);
          const value = asString(body.value);
          if (value === undefined) {
            return errorResponse(
              400,
              "NO_VALUE",
              "an answer needs a value",
              crypto.randomUUID(),
            );
          }
          const answered = await ask.answer(id, value);
          if (answered === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_INTERACTION",
              `no interaction ${id}`,
              crypto.randomUUID(),
            );
          }
          // Answering twice is not an error and not a second answer: the card comes back as it
          // stands, which is what a client retrying after a dropped connection needs.
          return Response.json(toInteraction(answered));
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/api/v1/chat/messages/:message_id/stop",
        async (_request, params) => {
          const id = params.message_id ?? "";
          const stopped = await runner.stop(id);
          if (stopped === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_MESSAGE",
              `no message ${id}`,
              crypto.randomUUID(),
            );
          }
          // `stopping` while the run winds down, `stopped` once it has: the run writes the second
          // state itself, and a client hears about it as a `message.updated` frame.
          return Response.json(toMessage(stopped));
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register("GET", "/api/v1/chat/interactions", (request) => {
        const raw = new URL(request.url).searchParams.get("limit");
        const limit = raw === null || raw.trim() === "" ? 100 : Number(raw);
        if (!Number.isFinite(limit) || limit <= 0) {
          return errorResponse(
            400,
            "BAD_LIMIT",
            `limit=${raw} is not a count`,
            crypto.randomUUID(),
          );
        }
        // Newest first, answered or not: the web's history page reads them like notifications.
        return Response.json({
          interactions: interactions.list(limit).map(toInteraction),
        });
      }),
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
        "/api/v1/agents/:agent_id",
        async (request, params) => {
          const id = params.agent_id ?? "";
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
            // `null` means "back to the project's default", `""` is that default's name — the
            // same statement, so both are accepted and neither is guessed.
            ...(body.persona === null
              ? { persona: "" }
              : typeof body.persona === "string"
                ? { persona: body.persona }
                : {}),
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
        "/api/v1/agents/:agent_id",
        (_request, params) => {
          const id = params.agent_id ?? "";
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

    // The conversation an agent has for itself, made on demand.
    //
    // The sidebar's member rows and its agent library both mean "talk to this one alone", and a
    // direct chat is where that happens. Idempotent: asking twice is how a caller says "make sure
    // it is there", which is what a button does every time it is pressed.
    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/api/v1/agents/:agent_id/direct",
        async (request, params) => {
          const id = params.agent_id ?? "";
          const agent = agents.get(id);
          if (agent === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_AGENT",
              `no agent ${id}`,
              crypto.randomUUID(),
            );
          }
          const body = await readJson(request).catch(
            () => ({}) as Record<string, unknown>,
          );
          // One conversation per (agent, folder): the same agent about two projects is two
          // conversations, because the folder decides where its work happens.
          const created = groups.ensurePrivateGroup(
            agent.id,
            agent.name,
            asString(body.cwd),
          );
          hub.publish("group.updated", { group: created.group });
          const group = groupShape(created.group.id);
          return group === undefined
            ? errorResponse(
                500,
                "NO_GROUP",
                "私聊刚建好就找不到了。",
                crypto.randomUUID(),
              )
            : Response.json(group);
        },
      ),
    );

    // Which persona card an agent wears. Its own route rather than a PATCH field: a persona is
    // chosen from the cards a project offers (which is a list, with names and descriptions), and
    // the two operations are different enough that one wire shape would describe neither.
    plugin.effect(() =>
      plugin.routes.register(
        "GET",
        "/api/v1/agents/:agent_id/persona",
        (_request, params) => {
          const id = params.agent_id ?? "";
          const agent = agents.get(id);
          if (agent === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_AGENT",
              `no agent ${id}`,
              crypto.randomUUID(),
            );
          }
          return Response.json({
            persona: agent.persona,
            // "" means the project's default; the interface says so in words instead of showing
            // an empty name.
            uses_project_default: agent.persona.length === 0,
          });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "PUT",
        "/api/v1/agents/:agent_id/persona",
        async (request, params) => {
          const id = params.agent_id ?? "";
          if (agents.get(id) === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_AGENT",
              `no agent ${id}`,
              crypto.randomUUID(),
            );
          }
          const body = await readJson(request);
          const persona = typeof body.persona === "string" ? body.persona : "";
          const record = agents.update(id, { persona });
          if (record === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_AGENT",
              `no agent ${id}`,
              crypto.randomUUID(),
            );
          }
          publishAgentUpdated(hub, record);
          // Runs already going keep the persona they started with; the next one reads this.
          return Response.json({
            persona: record.persona,
            uses_project_default: record.persona.length === 0,
          });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/api/v1/agents/:agent_id/restart",
        (_request, params) => {
          const id = params.agent_id ?? "";
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
