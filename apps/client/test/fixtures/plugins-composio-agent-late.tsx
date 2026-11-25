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

/** An entry of the `toolkits` section: the toolkit and the provider it comes from. */
type Pushed = ComposioPluginView & { provider: string };

const gmail: Pushed = {
  provider: "composio",
  name: "@composio/gmail",
  slug: "gmail",
  state: "ready",
  enabled: true,
};

/** A toolkit of a provider this client does not know. */
const other: Pushed = {
  provider: "nango",
  name: "@nango/slack",
  slug: "slack",
  state: "ready",
  enabled: true,
};

/**
 * The agent editor's plugin list on a host that publishes the `toolkits` section of the `plugins`
 * target, at the start of that host: the section is empty (the sessions are still being made), and
 * "host finishes sync" is the host having them from then on, which it sends as that section
 * changing. Nothing else changes; the list can be taken away and brought back, as when the page is
 * left and opened again.
 */
mount(() => {
  const host = createHost();
  host.state.update((state) => ({ ...state, status: "open" }));
  const section = signal<Pushed[]>([]);
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
    section: <T,>(target: string, key: string) =>
      (target === "plugins" && key === "toolkits" ? section() : undefined) as
        | T
        | undefined,
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
              section.set([gmail]);
            }}
          />
          <Button
            label="host lists two providers"
            onPress={() => section.set([gmail, other])}
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
