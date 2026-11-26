import type { MarketCatalog } from "@eta/client-contracts";
import { mount, View } from "nsh";
import { Label } from "../../src/components";
import { Market } from "../../src/pages/plugins/market";
import { createHost, Host } from "../../src/services/host";

const catalog: MarketCatalog = {
  proxy: "",
  sources: [
    {
      source: { url: "http://a.test/c.json", name: "A", enabled: true },
      entries: [
        {
          name: "one",
          description: "d",
          author: "t",
          version: "1.0.0",
          repo: "https://example.com/r.git",
          path: "plugins/one",
          rev: null,
          homepage: null,
          requires: [],
          installed: "no",
          unsupported: null,
          source: "http://a.test/c.json",
          sourceName: "A",
        },
        {
          name: "bad",
          description: "d",
          author: "t",
          version: "1.0.0",
          repo: "https://example.com/r.git",
          path: "plugins/bad",
          rev: null,
          homepage: null,
          requires: [],
          installed: "no",
          unsupported: null,
          source: "http://a.test/c.json",
          sourceName: "A",
        },
      ],
      rejected: [],
      error: null,
    },
  ],
};

(globalThis as { __calls?: string[] }).__calls = [];

function Fixture() {
  const host = createHost();
  host.state.update((state) => ({ ...state, status: "open" }));
  const stub = Object.assign(host, {
    call: async (
      _target: string,
      method: string,
      args: { name?: string; sha?: string },
    ) => {
      (globalThis as { __calls?: string[] }).__calls?.push(
        method + ":" + (args?.name ?? "") + ":" + (args?.sha ?? ""),
      );
      if (method === "marketCatalog")
        return JSON.parse(JSON.stringify(catalog)) as MarketCatalog;
      if (method === "marketPreview")
        return {
          name: args.name,
          repo: "https://example.com/r.git",
          path: "plugins/" + args.name,
          sha: "b".repeat(40),
          requires: ["node"],
          skills: [],
          servers: [
            {
              name: "srv",
              transport: "stdio",
              command: ["node", "run.js"],
              fixedEnv: {},
              env: [],
              headers: [],
            },
          ],
          fields: [],
          layout: null,
          reports: [],
          proxy: null,
        };
      if (method === "marketInstall" && args.name === "bad")
        throw new Error("the plugin name is taken by a local plugin");
      if (method === "marketInstall") {
        const entry = catalog.sources[0]!.entries!.find(
          (one) => one.name === args.name,
        );
        if (entry) entry.installed = "this";
      }
      return {};
    },
    action: async <T,>(run: () => Promise<T>) => await run(),
  });
  return (
    <Host.Provider value={stub}>
      <View style={{ flex: 1 }}>
        <Market
          onSettings={() => {}}
          layout="desktop"
          tabs={() => <Label>tabs</Label>}
        />
      </View>
    </Host.Provider>
  );
}
mount(() => <Fixture />);
