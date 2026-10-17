/**
 * The groups plugin: groups, their members and their timeline over HTTP (REFACTOR.md §9, P2.1).
 *
 *   GET    /groups                              every group, with its members
 *   POST   /groups            {name, goal?, cwd?, agentIds?}
 *   GET    /groups/:id
 *   PATCH  /groups/:id        {name?, goal?, decided?, cwd?}
 *   POST   /groups/:id/participants  {agentId}
 *   DELETE /groups/:id/participants/:agentId
 *   GET    /groups/:id/messages?since=<seq>     the timeline, oldest first
 *   POST   /groups/:id/messages {text, mentions?}
 *
 * The reply says what the routing rule decided: `woke` lists the agents this message woke, and it
 * is empty when nobody was named — an unmentioned message is context for everyone else, and that
 * is the rule, not an omission.
 *
 * Agent-authored messages (an agent naming another agent) do not come through here: they are
 * written by the projection reading that agent's session (P2.3). The wake budget they spend is
 * the store's business, which is where the tests for it live.
 */
import type { Context } from "cordis";
import type { TimelineProjector } from "../groups/projection";
import type { WakeRunner } from "../groups/runner";
import type { GroupStore } from "../groups/store";
import type { PluginContext } from "../plugin-api";
import { errorResponse } from "../routes";

export interface GroupsPluginConfig {
  groups: GroupStore;
  /** Turns the wakes this plugin records into runs (P2.2). */
  runner: WakeRunner;
  /** The write-and-publish pair: a post from one browser has to reach the others. */
  projector: TimelineProjector;
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

const asIds = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((id) => typeof id === "string")
    ? (value as string[])
    : undefined;

export const groupsPlugin = {
  name: "groups",
  inject: ["routes"],
  apply(ctx: Context, config: GroupsPluginConfig): void {
    const plugin = ctx as unknown as PluginContext;
    const { groups, runner, projector } = config;

    const notFound = (id: string): Response =>
      errorResponse(
        404,
        "NO_SUCH_GROUP",
        `no group ${id}`,
        crypto.randomUUID(),
      );

    plugin.effect(() =>
      plugin.routes.register("GET", "/groups", () =>
        Response.json({ groups: groups.list() }),
      ),
    );

    plugin.effect(() =>
      plugin.routes.register("POST", "/groups", async (request) => {
        const body = await readJson(request);
        const name = asString(body.name);
        if (name === undefined) {
          return errorResponse(
            400,
            "NO_NAME",
            "a group needs a name",
            crypto.randomUUID(),
          );
        }
        const agentIds = asIds(body.agentIds) ?? [];
        const created = groups.create({
          name,
          ...(asString(body.goal) === undefined
            ? {}
            : { goal: asString(body.goal)! }),
          ...(asString(body.cwd) === undefined
            ? {}
            : { cwd: asString(body.cwd)! }),
          agentIds,
        });
        // A new group has to reach every open sidebar, not just the browser that made it.
        projector.groupChanged(created.group.id);
        return Response.json(created, { status: 201 });
      }),
    );

    plugin.effect(() =>
      plugin.routes.register("GET", "/groups/:id", (_request, params) => {
        const id = params.id ?? "";
        const group = groups.get(id);
        return group === undefined ? notFound(id) : Response.json(group);
      }),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "PATCH",
        "/groups/:id",
        async (request, params) => {
          const id = params.id ?? "";
          if (groups.get(id) === undefined) return notFound(id);
          const body = await readJson(request);
          const updated = groups.update(id, {
            ...(asString(body.name) === undefined
              ? {}
              : { name: asString(body.name)! }),
            ...(asString(body.goal) === undefined
              ? {}
              : { goal: asString(body.goal)! }),
            ...(asString(body.decided) === undefined
              ? {}
              : { decided: asString(body.decided)! }),
            // A folder can be set later (that is the point of allowing ""), but an empty string
            // is not how you say "clear it": PATCH leaves out what it does not mention.
            ...(asString(body.cwd) === undefined
              ? {}
              : { cwd: asString(body.cwd)! }),
          });
          if (updated === undefined) return notFound(id);
          projector.groupChanged(id);
          return Response.json(updated);
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/groups/:id/participants",
        async (request, params) => {
          const id = params.id ?? "";
          const body = await readJson(request);
          const agentId = asString(body.agentId);
          if (agentId === undefined) {
            return errorResponse(
              400,
              "NO_AGENT",
              "an invitation needs an agentId",
              crypto.randomUUID(),
            );
          }
          const outcome = groups.addParticipant(id, agentId);
          if (outcome === "no-group") return notFound(id);
          if (outcome === "private") {
            return errorResponse(
              409,
              "PRIVATE_GROUP",
              "a private group has exactly one member; start a group to talk to several",
              crypto.randomUUID(),
            );
          }
          if (outcome === "member") {
            return errorResponse(
              409,
              "ALREADY_MEMBER",
              `${agentId} is already in this group`,
              crypto.randomUUID(),
            );
          }
          if (outcome === "no-agent") {
            return errorResponse(
              404,
              "NO_SUCH_AGENT",
              `no agent ${agentId}`,
              crypto.randomUUID(),
            );
          }
          projector.groupChanged(id);
          return Response.json(groups.get(id), { status: 201 });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "DELETE",
        "/groups/:id/participants/:agentId",
        (_request, params) => {
          const id = params.id ?? "";
          const agentId = params.agentId ?? "";
          const outcome = groups.removeParticipant(id, agentId);
          if (outcome === "no-group") return notFound(id);
          if (outcome === "private") {
            return errorResponse(
              409,
              "PRIVATE_GROUP",
              "a private group cannot lose its member",
              crypto.randomUUID(),
            );
          }
          if (outcome !== "ok") return notFound(agentId);
          projector.groupChanged(id);
          return new Response(null, { status: 204 });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "GET",
        "/groups/:id/messages",
        (request, params) => {
          const id = params.id ?? "";
          if (groups.get(id) === undefined) return notFound(id);
          const since = Number(
            new URL(request.url).searchParams.get("since") ?? "0",
          );
          return Response.json({
            messages: groups.messages(id, Number.isFinite(since) ? since : 0),
          });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/groups/:id/messages",
        async (request, params) => {
          const id = params.id ?? "";
          if (groups.get(id) === undefined) return notFound(id);
          const body = await readJson(request);
          const text = asString(body.text);
          if (text === undefined) {
            return errorResponse(
              400,
              "NO_TEXT",
              "a message needs text",
              crypto.randomUUID(),
            );
          }
          // Through the projector, so the row and the event are written together.
          const posted = projector.userMessage({
            groupId: id,
            text,
            mentions: asIds(body.mentions) ?? [],
          });
          // The wakes this message recorded are delivered now, and the answer says what each agent
          // replied. The timeline is projected as it runs (P2.3), so this response is only a
          // convenience for curl — a browser hears about all of it over the stream.
          const replies = await runner.deliver(id, posted.message.id);
          return Response.json({ ...posted, replies }, { status: 201 });
        },
      ),
    );
  },
};
