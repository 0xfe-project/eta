import type { PluginView } from "@eta/client-contracts";
import { mount, View } from "nsh";
import { Plugins } from "../../src/pages/plugins/plugins";
import { createHost, Host } from "../../src/services/host";

/** Installed plugins whose cards differ only in where they come from and whether they have a version. */
const plugin = (
  name: string,
  version: string | null,
  source: PluginView["source"],
  state: PluginView["state"] = "ready",
): PluginView => ({
  name,
  version,
  description: "desc-" + name,
  source,
  enabled: true,
  state,
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
const git = (repo: string): PluginView["source"] => ({
  kind: "git",
  repo,
  rev: "main",
  path: "",
  sha: "0123456789abcdef0123456789abcdef01234567",
});
const local = (name: string): PluginView["source"] => ({
  kind: "local",
  path: "/p/" + name,
});

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
            plugin("git-plugin", "2.0.0", git("acme/tools")),
            plugin("local-plugin", "1.0.0", local("local-plugin")),
            plugin("bare-git-plugin", null, git("acme/bare")),
            plugin("bare-local-plugin", null, local("bare-local-plugin")),
            plugin(
              "config-git-plugin",
              "3.0.0",
              git("acme/needs-a-long-repository-name"),
              "needs_config",
            ),
          ],
          audit: [],
        },
      },
    },
  }));
  const stub = Object.assign(host, {
    call: async () => undefined,
    action: async <T,>(run: () => Promise<T>) => await run(),
  });
  return (
    <Host.Provider value={stub}>
      <View style={{ flex: 1 }}>
        <Plugins onSettings={() => {}} layout="desktop" />
      </View>
    </Host.Provider>
  );
}
mount(() => <Fixture />);
