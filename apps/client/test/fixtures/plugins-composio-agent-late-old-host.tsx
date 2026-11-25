import type { ComposioPluginView, PluginView } from "@eta/client-contracts";
import type { AgentForm } from "../../src/pages/settings/agents/form";
import { mount, signal, View } from "nsh";
import { Button, Label } from "../../src/components";
import { AgentPlugins } from "../../src/pages/settings/agents/plugins";
import { createHost, Host } from "../../src/services/host";

const installed: PluginView = {
  name: "on-plugin",
  version: "1.0.0",
  description: "d",
  source: { kind: "local", path: "/p/on-plugin" },
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
};

const gmail: ComposioPluginView = {
  name: "@composio/gmail",
  slug: "gmail",
  state: "ready",
  enabled: true,
};

/**
 * The same list on a host older than the `toolkits` section: it has no such section, so the only
 * source is `composioPlugins`, whose first answer is empty (the sessions are still being made).
 * "host finishes sync" is the host having them from then on; nothing is pushed. "asked" counts the
 * `composioPlugins` calls, and the list can be taken away and brought back.
 */
mount(() => {
  const host = createHost();
  host.state.update((state) => ({ ...state, status: "open" }));
  const asked = signal(0);
  const visible = signal(true);
  let virtuals: ComposioPluginView[] = [];
  const form = {
    plugins: signal<string[]>([]),
    runtime: signal("eta"),
    phoneEditor: () => false,
  } as unknown as AgentForm;
  const stub = Object.assign(host, {
    list: <T,>(target: string) =>
      (target === "plugins" ? [installed] : []) as T[],
    section: () => undefined,
    call: async (_target: string, method: string) => {
      if (method !== "composioPlugins") return undefined;
      asked.update((n) => n + 1);
      return { plugins: virtuals };
    },
    action: async <T,>(run: () => Promise<T>) => await run(),
  });
  return (
    <Host.Provider value={stub}>
      <View style={{ flex: 1 }}>
        <Label>{"asked:" + asked()}</Label>
        <View style={{ flexDirection: "row" }}>
          <Button
            label="host finishes sync"
            onPress={() => {
              virtuals = [gmail];
            }}
          />
          <Button label="hide list" onPress={() => visible.set(false)} />
          <Button label="show list" onPress={() => visible.set(true)} />
        </View>
        <If when={visible()}>
          <AgentPlugins form={form} />
        </If>
      </View>
    </Host.Provider>
  );
});
