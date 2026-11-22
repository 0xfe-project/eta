import type { PluginServerView } from "@eta/client-contracts";
import type { PluginPackage } from "@eta/daemon";
import { plainRemote, serverSupported } from "@eta/daemon";

/** The MCP servers of a plugin as the user is shown them: what each runs, or where it connects. */
export function serverViews(
  plugin: PluginPackage | undefined,
): PluginServerView[] {
  return (plugin?.servers ?? []).map((server) => {
    const binding = plugin?.bindings[server.name];
    const { config } = server;
    return {
      name: server.name,
      transport: config.type,
      ...(config.type === "stdio"
        ? { command: [config.command, ...config.args] }
        : { url: config.url }),
      env: Object.keys(binding?.env ?? {}),
      ...(config.type === "stdio"
        ? {
            lockedEnv: [
              ...new Set([
                ...Object.entries(
                  (config as { env?: Record<string, string> }).env ?? {},
                )
                  .filter(([, value]) => value !== "")
                  .map(([name]) => name),
                ...Object.keys(binding?.env ?? {}),
                "PLUGIN_ROOT",
                "PLUGIN_DATA",
              ]),
            ],
          }
        : {}),
      // Names only, never values: the ones the plugin file sets, and the ones eta fills from fields.
      headers: [
        ...new Set([
          ...(config.type === "stdio" ? [] : Object.keys(config.headers)),
          ...Object.keys(binding?.headers ?? {}),
        ]),
      ],
      plainHttp: config.type !== "stdio" && plainRemote(config.url),
      problem: serverSupported(server)
        ? null
        : "legacy HTTP+SSE: external runtimes skip it; eta's own loop takes it",
    };
  });
}
