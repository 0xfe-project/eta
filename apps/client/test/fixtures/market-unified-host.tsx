import type {
  ComposioToolkit,
  MarketCatalog,
  MarketEntry,
} from "@eta/client-contracts";
import { mount, View } from "nsh";
import { Label } from "../../src/components";
import { Market } from "../../src/pages/plugins/market";
import { createHost, Host } from "../../src/services/host";

/** 30 Composio toolkits, then 200 plugins of another source: more cards than one batch, of both kinds. */
const toolkit = (i: number): ComposioToolkit => ({
  kind: "composio",
  slug: "app" + i,
  name: "Toolkit " + String(i).padStart(4, "0"),
  description: "d" + i,
  auth: "oauth",
  authSchemes: [],
  managed: true,
  categories: [],
  logo: null,
  appUrl: null,
  toolsCount: 1,
  source: "composio",
  sourceName: "Composio",
});
const entry = (i: number): MarketEntry => ({
  name: "Plugin " + String(i).padStart(4, "0"),
  description: "desc " + i,
  author: "a",
  version: "1.0.0",
  repo: "",
  path: "",
  rev: null,
  homepage: null,
  requires: [],
  installed: "no",
  unsupported: null,
  source: "http://a.test/c.json",
  sourceName: "Alpha",
});
const catalog: MarketCatalog = {
  proxy: "",
  sources: [
    {
      source: {
        url: "composio",
        name: "Composio",
        enabled: true,
        kind: "composio" as const,
      },
      status: "ready",
      entries: [],
      toolkits: Array.from({ length: 30 }, (_, i) => toolkit(i)),
      rejected: [],
      error: null,
    },
    {
      source: { url: "http://a.test/c.json", name: "Alpha", enabled: true },
      entries: Array.from({ length: 200 }, (_, i) => entry(i)),
      rejected: [],
      error: null,
    },
  ],
};

export function mountUnified(layout: "desktop" | "phone") {
  mount(() => {
    const host = createHost();
    host.state.update((state) => ({ ...state, status: "open" }));
    const stub = Object.assign(host, {
      call: async (_target: string, method: string) => {
        if (method === "marketCatalog")
          return JSON.parse(JSON.stringify(catalog)) as MarketCatalog;
        if (method === "composioConnected")
          return { status: "ready", slugs: [] };
        return {};
      },
      action: async <T,>(run: () => Promise<T>) => await run(),
    });
    return (
      <Host.Provider value={stub}>
        <View style={{ flex: 1 }}>
          <Market
            onSettings={() => {}}
            layout={layout}
            tabs={() => <Label>tabs</Label>}
          />
        </View>
      </Host.Provider>
    );
  });
}
