import type { PluginView } from "@eta/client-contracts";
import { mount, View } from "nsh";
import { Plugins } from "../../src/pages/plugins/plugins";
import { createHost, Host } from "../../src/services/host";

const remote = {
  name: "fc",
  transport: "streamable-http" as const,
  url: "https://example.com/mcp",
  env: [],
  headers: [],
  plainHttp: false,
  problem: null,
};

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
          list: [
            plugin("on-plugin", true),
            plugin("off-plugin", false),
            {
              ...plugin("remote-plugin", true),
              servers: [remote],
              skills: [{ name: "only-skill", description: "<b>x</b> does one thing" }],
            },
            { ...plugin("signed-plugin", true), servers: [{ ...remote, login: "signed_in" as const }] },
            { ...plugin("login-plugin", true), servers: [{ ...remote, login: "needs_login" as const }] },
            { ...plugin("setup-plugin", true), state: "needs_config" as const, servers: [remote] },
            // An older host sends neither `headers` on the plugin nor on its servers.
            {
              ...plugin("old-host-plugin", true),
              skills: ["alpha", "beta", "gamma"].map((name) => ({ name, description: name + " skill" })),
              headers: undefined,
              servers: [{ ...remote, headers: undefined, plainHttp: undefined }],
            } as unknown as PluginView,
          ],
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
