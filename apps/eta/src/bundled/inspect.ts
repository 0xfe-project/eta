import type { SessionManager } from "@eta/server";
import type { InteractionStore } from "../interactions/store";
import type { Context } from "cordis";
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
