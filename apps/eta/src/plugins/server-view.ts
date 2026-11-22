import type { PluginServerView } from "@eta/client-contracts";
import type { PluginPackage } from "@eta/daemon";
import { serverSupported } from "@eta/daemon";

/** The MCP servers of a plugin as the user is shown them: what each runs, or where it connects. */
export function serverViews(plugin: PluginPackage | undefined): PluginServerView[] {
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
      headers: Object.keys(binding?.headers ?? {}),
      problem: serverSupported(server)
        ? null
        : "legacy HTTP+SSE: external runtimes skip it; eta's own loop takes it",
    };
  });
}
