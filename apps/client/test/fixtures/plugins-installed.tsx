import type { PluginView } from "@eta/client-contracts";
import { mount, View } from "nsh";
import { Plugins } from "../../src/pages/plugins/plugins";
import { createHost, Host } from "../../src/services/host";

const plugin = (name: string, enabled: boolean): PluginView => ({
  name,
  version: "1.0.0",
  description: "d",
  source: { kind: "local", path: "/p/" + name },
  enabled,
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

(globalThis as { __calls?: unknown[] }).__calls = [];

function Fixture() {
  const host = createHost();
  host.state.update((state) => ({
    ...state,
    status: "open",
    targets: {
      ...state.targets,
      plugins: {
        version: 1,
        revisions: {},
        sections: {
          list: [plugin("on-plugin", true), plugin("off-plugin", false)],
          audit: [],
        },
      },
    },
  }));
  const stub = Object.assign(host, {
    call: async (_target: string, method: string, args: unknown) => {
      (globalThis as { __calls?: unknown[] }).__calls?.push([method, args]);
      return undefined;
    },
    action: async <T,>(run: () => Promise<T>) => await run(),
  });
  return (
    <Host.Provider value={stub}>
      <View style={{ flex: 1 }}>
        <Plugins layout="desktop" />
      </View>
    </Host.Provider>
  );
}
mount(() => <Fixture />);
