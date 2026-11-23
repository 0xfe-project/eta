import type {
  ComposioToolkit,
  MarketCatalog,
  PluginView,
} from "@eta/client-contracts";
import type { Layout } from "../../src/components";
import { mount, signal, View } from "nsh";
import { Label } from "../../src/components";
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

const toolkit = (slug: string, name: string): ComposioToolkit => ({
  kind: "composio",
  slug,
  name,
  description: name + " toolkit",
  auth: "oauth",
  authSchemes: [],
  managed: true,
  categories: [],
  logo: null,
  appUrl: null,
  toolsCount: 3,
  source: "composio",
  sourceName: "Composio",
});

/** What the kept list holds: gmail and exa. A connected `ghost` is not in it. */
const kept: MarketCatalog = {
  proxy: "",
  sources: [
    {
      source: {
        url: "composio",
        name: "Composio",
        enabled: true,
        kind: "composio",
      },
      entries: [],
      rejected: [],
      error: null,
      status: "ready",
      toolkits: [toolkit("gmail", "Gmail"), toolkit("exa", "Exa")],
    },
  ],
};

/**
 * The installed page over two plugins. `connected`: what Composio says is connected: two toolkits
 * (one of them not in the kept list), none, or the question fails. The page names them with
 * `composioToolkits` (the slugs it asks about are shown as `asked:…`); a whole list asked for
 * (`marketCatalog`, of any mode) is shown as text, so a test can see that none was.
 */
export function openInstalled(
  layout: Layout,
  connected: "two" | "none" | "fails",
) {
  mount(() => {
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
          },
        },
      },
    }));
    const refreshed = signal(false);
    const asked = signal<string[]>([]);
    const stub = Object.assign(host, {
      call: async (_target: string, method: string, args: unknown) => {
        if (method === "composioConnected") {
          if (connected === "fails") throw new Error("Composio is down");
          return {
            status: "ready",
            slugs: connected === "two" ? ["gmail", "ghost"] : [],
          };
        }
        if (method === "composioToolkits") {
          const slugs = (args as { slugs: string[] }).slugs;
          asked.set([...asked(), slugs.join(",")]);
          return {
            toolkits: kept.sources[0]!.toolkits!.filter((one) =>
              slugs.includes(one.slug),
            ),
          };
        }
        if (method === "marketCatalog") {
          refreshed.set(true);
          return JSON.parse(JSON.stringify(kept)) as MarketCatalog;
        }
        return undefined;
      },
      action: async <T,>(run: () => Promise<T>) => await run(),
    });
    return (
      <Host.Provider value={stub}>
        <View style={{ flex: 1 }}>
          <Label>{"asked:" + asked().join(";")}</Label>
          <If when={refreshed()}>
            <Label>asked-the-network</Label>
          </If>
          <Plugins layout={layout} />
        </View>
      </Host.Provider>
    );
  });
}
