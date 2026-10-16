/**
 * The usage plugin: who spent what (REFACTOR.md §9, P1.3).
 *
 *   GET /usage/agents     every subject, with its windows and its per-model split
 *
 * The management API of P1.4 will re-shape this for the settings page (connections, catalog and
 * usage in one place); this is the same numbers, reachable today.
 */
import type { Context } from "cordis";
import type { PluginContext } from "../plugin-api";
import type { UsageStore } from "../usage/store";

export interface UsagePluginConfig {
  usage: UsageStore;
}

export const usagePlugin = {
  name: "usage",
  inject: ["routes"],
  apply(ctx: Context, config: UsagePluginConfig): void {
    const plugin = ctx as unknown as PluginContext;
    plugin.effect(() =>
      plugin.routes.register("GET", "/usage/agents", () =>
        Response.json({ agents: config.usage.bySubject() }),
      ),
    );
  },
};
