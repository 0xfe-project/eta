import type { SessionManager } from "@eta/server";
import type { Context } from "cordis";
import type { InteractionStore } from "../interactions/store";
import type { PluginContext } from "../plugin-api";
import { errorResponse } from "../routes";

/**
 * What a session is made of, for the panel that shows it.
 *
 * Three reads, one per question a person actually asks:
 *
 *   GET /sessions/:id/prompt   the system prompt, split into the part a provider can cache and
 *                              the part that is rewritten every generation
 *   GET /sessions/:id/tools    the tools this session can call right now
 *   GET /sessions/:id/usage    what it has spent: tokens in, out, cached, and the compaction epoch
 *
 * All three are reads of live services, not of a stored snapshot: a session's tools are installed
 * when it opens, its prompt is composed per generation, and its numbers move while it runs. A
 * cached copy would be a copy that disagrees with the thing it describes.
 *
 * Nothing here is invented. A session that is not open answers 404 rather than a plausible zero:
 * "this conversation has no numbers yet" and "this conversation has used nothing" are different
 * sentences, and only one of them is true.
 */
export interface InspectPluginConfig {
  sessions: SessionManager;
  /** The questions this session has asked, so the tool list can say how often a tool was stopped. */
  interactions: InteractionStore;
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

export const inspectPlugin = {
  name: "inspect",
  inject: ["routes"],
  apply(ctx: Context, config: InspectPluginConfig): void {
    const plugin = ctx as unknown as PluginContext;
    const { sessions, interactions } = config;

    const missing = (id: string) =>
      errorResponse(
        404,
        "NO_SUCH_SESSION",
        `no open session ${id}`,
        crypto.randomUUID(),
      );

    plugin.effect(() =>
      plugin.routes.register(
        "GET",
        "/sessions/:id/prompt",
        async (_request, params) => {
          const id = params.id ?? "";
          const managed = await sessions.session(id);
          if (managed === undefined) return missing(id);
          const prompt = await managed.session.promptSections();
          return Response.json({
            sections: prompt.sections.map((section) => ({
              name: section.name,
              stable: section.stable,
              chars: section.text.length,
              text: section.text,
            })),
            stable_chars: prompt.stableChars,
            adaptive_chars: prompt.adaptiveChars,
            // How many named blocks the prompt is made of — the number the panel shows instead
            // of the prompt itself.
            blocks: prompt.sections.length,
          });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "GET",
        "/sessions/:id/tools",
        async (_request, params) => {
          const id = params.id ?? "";
          const managed = await sessions.session(id);
          if (managed === undefined) return missing(id);
          const inspect = managed.session.kernel.inspect();
          // A tool that had to ask before it ran, and was refused, is a fact about the run rather
          // than about the tool: the count comes from the cards the session raised, not from a
          // counter nobody keeps.
          const asked = interactions.ofSession(id);
          const refused = asked.filter(
            (card) =>
              card.status === "resolved" &&
              (card.answer === "deny" || card.answer === "denied"),
          ).length;
          // `tools` is what the kernel holds; `active` is what the model is offered. They differ
          // when a tool was registered after the session pinned its list, and the difference is
          // the kind of thing a panel exists to make visible.
          const active = managed.session.config.activeToolNames ?? [];
          return Response.json({
            tools: inspect.tools,
            active,
            blocked: inspect.tools.filter((name) => !active.includes(name)),
            asked: asked.length,
            refused,
          });
        },
      ),
    );

    // What a conversation is running on, and how hard it is thinking.
    //
    // Two properties of the session's own configuration, read live every turn by the runner: a
    // patch here is a patch the next turn picks up, which is why the panel can show "asked for X,
    // running Y" and be telling the truth while a turn is in flight.
    plugin.effect(() =>
      plugin.routes.register(
        "GET",
        "/sessions/:id/model",
        async (_request, params) => {
          const id = params.id ?? "";
          const managed = await sessions.session(id);
          if (managed === undefined) return missing(id);
          const config = managed.session.config;
          return Response.json({
            model:
              config.model === undefined
                ? null
                : `${config.model.provider}:${config.model.modelId}`,
            thinking_level: config.thinkingLevel ?? "off",
          });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "PATCH",
        "/sessions/:id/model",
        async (request, params) => {
          const id = params.id ?? "";
          const managed = await sessions.session(id);
          if (managed === undefined) return missing(id);
          const body = await readJson(request);
          const patch: Record<string, unknown> = {};
          const model = typeof body.model === "string" ? body.model : undefined;
          if (model !== undefined) {
            const at = model.indexOf(":");
            if (at <= 0 || at === model.length - 1) {
              return errorResponse(
                400,
                "BAD_MODEL",
                `not a model id (provider:model): ${model}`,
                crypto.randomUUID(),
              );
            }
            patch.model = {
              provider: model.slice(0, at),
              modelId: model.slice(at + 1),
            };
          }
          if (typeof body.thinking_level === "string")
            patch.thinkingLevel = body.thinking_level;
          try {
            managed.session.kernel.config.update(patch);
          } catch (error) {
            // Validation lives in the kernel; this surface only reports what it said.
            return errorResponse(
              400,
              "BAD_CONFIG",
              error instanceof Error ? error.message : "invalid configuration",
              crypto.randomUUID(),
            );
          }
          const config = managed.session.config;
          return Response.json({
            model:
              config.model === undefined
                ? null
                : `${config.model.provider}:${config.model.modelId}`,
            thinking_level: config.thinkingLevel ?? "off",
          });
        },
      ),
    );

    // The goal a conversation is chasing.
    //
    // The kernel already has the whole machine — active / paused / achieved, an anti-spin limit,
    // a continuation cap — and until now nothing could reach it, so `/goal` had no equivalent
    // here. These two routes are the reach: read it, and move it.
    plugin.effect(() =>
      plugin.routes.register(
        "GET",
        "/sessions/:id/goal",
        async (_request, params) => {
          const id = params.id ?? "";
          const managed = await sessions.session(id);
          if (managed === undefined) return missing(id);
          const goal = managed.session.kernel.goal.current;
          return Response.json({
            goal:
              goal === undefined
                ? null
                : {
                    objective: goal.objective,
                    status: goal.status,
                    rounds: goal.roundCount,
                  },
          });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/sessions/:id/goal",
        async (request, params) => {
          const id = params.id ?? "";
          const managed = await sessions.session(id);
          if (managed === undefined) return missing(id);
          const body = await readJson(request);
          const action = typeof body.action === "string" ? body.action : "";
          const goal = managed.session.kernel.goal;
          if (action === "set") {
            const objective =
              typeof body.objective === "string" ? body.objective.trim() : "";
            if (objective.length === 0) {
              return errorResponse(
                400,
                "NO_OBJECTIVE",
                "a goal needs something to aim at",
                crypto.randomUUID(),
              );
            }
            goal.set(objective);
          } else if (action === "pause") {
            goal.pause();
          } else if (action === "resume") {
            goal.resume();
          } else if (action === "clear") {
            goal.clear();
          } else {
            return errorResponse(
              400,
              "UNKNOWN_ACTION",
              `not a goal action: ${action}`,
              crypto.randomUUID(),
            );
          }
          const next = goal.current;
          return Response.json({
            goal:
              next === undefined
                ? null
                : {
                    objective: next.objective,
                    status: next.status,
                    rounds: next.roundCount,
                  },
          });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "GET",
        "/sessions/:id/usage",
        async (_request, params) => {
          const id = params.id ?? "";
          const managed = await sessions.session(id);
          if (managed === undefined) return missing(id);
          const { config, journaling } = managed.session;
          // The live transcript, not the one the session was opened with: `transcript` is a
          // snapshot from open time, so summing it reports zero after every run.
          const transcript = journaling.transcript();
          // Summed from the messages themselves. The usage ledger counts under the *agent*
          // (one row for every conversation it has ever had), so it cannot answer "what did this
          // conversation spend" — and a number that silently means something else is worse than
          // no number.
          let input = 0;
          let output = 0;
          let cacheRead = 0;
          let cacheWrite = 0;
          let turns = 0;
          for (const message of transcript) {
            if (message.role !== "assistant") continue;
            turns += 1;
            const usage = message.usage;
            if (usage === undefined) continue;
            input += usage.input;
            output += usage.output;
            cacheRead += usage.cacheRead;
            cacheWrite += usage.cacheWrite;
          }
          // How many times the history was cut and rewritten: the number that explains why the
          // context is small while the totals are large.
          const compactions = journaling
            .entries()
            .filter((entry) => entry.type === "compaction").length;
          return Response.json({
            input,
            output,
            cache_read: cacheRead,
            cache_write: cacheWrite,
            turns,
            compactions,
            model:
              config.model === undefined
                ? null
                : `${config.model.provider}:${config.model.modelId}`,
          });
        },
      ),
    );
  },
};
