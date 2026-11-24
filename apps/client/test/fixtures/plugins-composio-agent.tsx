import type { ComposioPluginView, PluginView } from "@eta/client-contracts";
import type { AgentForm } from "../../src/pages/settings/agents/form";
import { mount, signal, View } from "nsh";
import { Label } from "../../src/components";
import { AgentPlugins } from "../../src/pages/settings/agents/plugins";
import { createHost, Host } from "../../src/services/host";

const real = (name: string): PluginView => ({
  name,
  version: "1.0.0",
  description: "d",
  source: { kind: "local", path: "/p/" + name },
  enabled: true,
  state: "ready",
  problem: null,
  reports: [],
  skills: [],
  servers: [],
  requires: [],
  machines: [],
  fields: [],
  headers: [],
  agents: [],
});

/**
 * The agent editor's plugin list over a scripted host: one installed plugin, and the connected
 * Composio toolkits as the host's `composioPlugins` lists them (`undefined`: the host does not
 * know the call). The form is the two things the list reads, with the agent's choices shown as text.
 */
export function openAgent(
  virtuals: ComposioPluginView[] | undefined,
  options: { runtime?: string; chosen?: string[] } = {},
) {
  mount(() => {
    const host = createHost();
    host.state.update((state) => ({ ...state, status: "open" }));
    const plugins = signal<string[]>(options.chosen ?? []);
    const runtime = signal(options.runtime ?? "eta");
    const form = {
      plugins,
      runtime,
      phoneEditor: () => false,
    } as unknown as AgentForm;
    const stub = Object.assign(host, {
      list: <T,>(target: string) =>
        (target === "plugins" ? [real("on-plugin")] : []) as T[],
      call: async (_target: string, method: string) =>
        method === "composioPlugins" && virtuals !== undefined
          ? { plugins: virtuals }
          : undefined,
      action: async <T,>(run: () => Promise<T>) => await run(),
    });
    return (
      <Host.Provider value={stub}>
        <View style={{ flex: 1 }}>
          <Label>{"chosen:" + plugins().join(",")}</Label>
          <AgentPlugins form={form} />
        </View>
      </Host.Provider>
    );
  });
}
