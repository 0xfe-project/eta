/**
 * The management surface (REFACTOR.md §9, P1.4).
 *
 *   GET  /api/llm/v1/connectors     which kinds of account exist
 *   GET  /api/llm/v1/connections    which ones this host has, and whether they work
 *   GET  /api/llm/v1/models         which models a chat may use
 *   GET  /api/llm/v1/usage          provider-reported quotas (empty: this host does not poll them)
 *   GET  /api/llm/v1/usage/agents   what each agent spent, counted here
 *   POST /api/llm/v1/refresh        look again now
 *
 * This is not the inference proxy — a chat's own calls go through the model layer, not through
 * these routes. What is here is what a settings page reads, and every answer is derived from the
 * config, the catalog and the usage table (see `admin/llm.ts` for the derivation rules).
 */
import type { Context } from "cordis";
import type { PluginContext } from "../plugin-api";
import type { ProviderCatalogEntry } from "../providers/catalog";
import type { EtaProviderConfig } from "../providers/config-types";
import type { ProviderBuildFailure } from "../providers/runtime";
import type { UsageStore } from "../usage/store";
import {
  agentUsageOf,
  connectionsOf,
  connectorsOf,
  modelsOf,
  usageOf,
} from "../admin/llm";
import { errorResponse } from "../routes";

export interface AdminPluginConfig {
  providers: readonly EtaProviderConfig[];
  catalog: ReadonlyMap<string, ProviderCatalogEntry>;
  failures: readonly ProviderBuildFailure[];
  /** Provider ids a device-code login has credentials for, read fresh on every request. */
  signedIn: () => Promise<readonly string[]>;
  /** The usage table, for the two usage routes. */
  usage: Pick<UsageStore, "bySubject" | "lastPerProvider">;
  /** When the config was last written: when these connections were last changed. */
  createdAt: string;
}

export const adminPlugin = {
  name: "admin",
  inject: ["routes"],
  apply(ctx: Context, config: AdminPluginConfig): void {
    const plugin = ctx as unknown as PluginContext;

    /** Everything the derivations need, read fresh: credentials expire and calls keep happening. */
    const input = async (): Promise<Parameters<typeof connectionsOf>[0]> => ({
      providers: config.providers,
      catalog: config.catalog,
      failures: config.failures,
      recent: config.usage.lastPerProvider(),
      signedIn: await config.signedIn(),
      createdAt: config.createdAt,
    });

    plugin.effect(() =>
      plugin.routes.register("GET", "/api/llm/v1/connectors", () =>
        Response.json(connectorsOf(config.catalog)),
      ),
    );

    plugin.effect(() =>
      plugin.routes.register("GET", "/api/llm/v1/connections", async () =>
        Response.json(connectionsOf(await input())),
      ),
    );

    plugin.effect(() =>
      plugin.routes.register("GET", "/api/llm/v1/models", async () =>
        Response.json(modelsOf(await input())),
      ),
    );

    plugin.effect(() =>
      plugin.routes.register("GET", "/api/llm/v1/usage", async () =>
        Response.json(usageOf(await input())),
      ),
    );

    plugin.effect(() =>
      plugin.routes.register("GET", "/api/llm/v1/usage/agents", () =>
        Response.json({ usage: agentUsageOf(config.usage.bySubject()) }),
      ),
    );

    plugin.effect(() =>
      plugin.routes.register("POST", "/api/llm/v1/refresh", async () => {
        // The document the page reads is derived, so "refresh" is the same read: nothing here
        // caches a provider's state, and the credential file is read again on the way through.
        const fresh = await input();
        if (fresh.providers.length === 0) {
          return errorResponse(
            409,
            "NO_PROVIDERS",
            "no providers are configured",
            crypto.randomUUID(),
          );
        }
        return Response.json({
          connections: connectionsOf(fresh),
          models: modelsOf(fresh),
          usage: usageOf(fresh),
        });
      }),
    );
  },
};
