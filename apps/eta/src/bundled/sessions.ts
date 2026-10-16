import type { SessionManager } from "@eta/server";
/**
 * The sessions plugin: the REST surface over the session host (REFACTOR.md §9, P0.7).
 *
 * Small on purpose. It owns no state — the manager and the hub are the host's, handed in — and
 * it knows nothing about groups, agents or views: those arrive in P2 and P3. What it does is
 * make a session reachable over HTTP the way `curl` and a test want it:
 *
 *   GET  /sessions                       what the host holds
 *   POST /sessions            {cwd?…}    create one
 *   GET  /sessions/:id/messages          its transcript, as text
 *   POST /sessions/:id/prompt {text}     say something, wait for the run to end
 *   POST /sessions/:id/abort             stop the run in flight
 *
 * A prompt waits for its run on purpose: streaming the run over `/events` is P2's projection,
 * and a blocking answer is the version that can be curled today.
 */
import type { Context } from "cordis";
import type { EventHub } from "../http/events";
import type { PluginContext } from "../plugin-api";
import { errorResponse } from "../routes";
import { lastAssistantText, textOf } from "../sessions/transcript";

export interface SessionsPluginConfig {
  sessions: SessionManager;
  hub: EventHub;
}

/** The text of a message, for a client that wants to read a conversation rather than replay it. */

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

export const sessionsPlugin = {
  name: "sessions",
  inject: ["routes"],
  apply(ctx: Context, config: SessionsPluginConfig): void {
    const plugin = ctx as unknown as PluginContext;
    const { sessions, hub } = config;

    plugin.effect(() =>
      plugin.routes.register("GET", "/sessions", async () =>
        Response.json({ sessions: await sessions.list() }),
      ),
    );

    plugin.effect(() =>
      plugin.routes.register("POST", "/sessions", async (request) => {
        const body = await readJson(request);
        const managed = await sessions.create({
          ...(asString(body.cwd) === undefined
            ? {}
            : { cwd: asString(body.cwd)! }),
          ...(asString(body.title) === undefined
            ? {}
            : { title: asString(body.title)! }),
          ...(asString(body.persona) === undefined
            ? {}
            : { persona: asString(body.persona)! }),
          ...(asString(body.model) === undefined
            ? {}
            : { model: asString(body.model)! }),
        });
        hub.publish("session.created", { id: managed.meta.id });
        return Response.json({ meta: managed.meta }, { status: 201 });
      }),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "GET",
        "/sessions/:id/messages",
        async (_request, params) => {
          const id = params.id ?? "";
          const managed = await sessions.session(id);
          if (managed === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_SESSION",
              `no session ${id}`,
              crypto.randomUUID(),
            );
          }
          return Response.json({
            meta: managed.meta,
            messages: managed.session.journaling
              .transcript()
              .map((message) => ({
                role: message.role,
                text: textOf(message),
              })),
          });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/sessions/:id/prompt",
        async (request, params) => {
          const id = params.id ?? "";
          const managed = await sessions.session(id);
          if (managed === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_SESSION",
              `no session ${id}`,
              crypto.randomUUID(),
            );
          }
          const body = await readJson(request);
          const text = asString(body.text);
          if (text === undefined) {
            return errorResponse(
              400,
              "NO_TEXT",
              "a prompt needs a text",
              crypto.randomUUID(),
            );
          }

          managed.session.kernel.inject({
            role: "user",
            timestamp: Date.now(),
            content: [{ type: "text", text }],
          });
          const result = await managed.session.runner.run();
          // The live conversation is the journal's; the snapshot taken at open is not it.
          const said = lastAssistantText(managed);
          hub.publish("session.turn", {
            id,
            status: result.status,
            turns: result.turns,
          });
          if (result.status === "failed") {
            return errorResponse(
              502,
              "RUN_FAILED",
              result.error ?? "the run failed",
              crypto.randomUUID(),
            );
          }
          return Response.json({
            status: result.status,
            turns: result.turns,
            text: said,
          });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/sessions/:id/abort",
        async (_request, params) => {
          const id = params.id ?? "";
          const managed = await sessions.session(id);
          if (managed === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_SESSION",
              `no session ${id}`,
              crypto.randomUUID(),
            );
          }
          managed.session.runner.abort();
          return Response.json({ aborted: true });
        },
      ),
    );
  },
};
