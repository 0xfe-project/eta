/**
 * The first bundled plugin: the host answering for itself.
 *
 * `/host` is what a caller checks when it wants to know whether this process is the one it
 * thinks it is — pid, data directory, how long it has been up, which plugins are mounted. It is
 * a plugin rather than part of the floor, so "the floor serves with no plugins at all" stays
 * true: `/health` is the floor's, `/host` is this plugin's.
 */
import type { Context } from "cordis";
import type { PluginContext } from "../plugin-api";

export interface HostStatus {
  pid: number;
  /** The host process's own version (`--version` / package), not the page bundle's. */
  version: string;
  dataDir: string;
  /** Where the database file is, so a caller can find it without guessing. */
  dbPath: string;
  /** The last migration that ran. */
  schema: string | undefined;
  /** The providers the config lists, each marked when it could not be built. */
  providers: string[];
  startedAt: number;
  /** The mounted plugins, by name, with the reason when one failed. */
  mounted: string[];
}

export interface HostPluginConfig {
  status: HostStatus;
}

export const hostPlugin = {
  name: "host",
  inject: ["routes"],
  apply(ctx: Context, config: HostPluginConfig): void {
    // The context a plugin is typed against is structural (plugin-api.ts); cordis's own
    // context is the thing that satisfies it at runtime.
    const plugin = ctx as unknown as PluginContext;
    plugin.effect(() =>
      plugin.routes.register("GET", "/host", () =>
        Response.json(config.status),
      ),
    );
  },
};
