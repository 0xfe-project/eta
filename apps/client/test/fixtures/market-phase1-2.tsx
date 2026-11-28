import type { MarketCatalog, MarketPreview } from "@eta/client-contracts";
import { mount, signal, View } from "nsh";
import { Button, Label } from "../../src/components";
import { Market } from "../../src/pages/plugins/market";
import { createHost, Host } from "../../src/services/host";

type Scenario = "composio-only" | "cold-cache" | "needs-key" | "manifest-diff";

function makeCatalog(scenario: Scenario): MarketCatalog {
  if (scenario === "composio-only") {
    return {
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
          toolkits: [
            {
              kind: "composio",
              slug: "gmail",
              name: "Gmail",
              description: "Email toolkit",
              auth: "oauth",
              authSchemes: [],
              managed: true,
              categories: [],
              logo: null,
              appUrl: null,
              toolsCount: 5,
              source: "composio",
              sourceName: "Composio",
            },
          ],
        },
      ],
    };
  }
  if (scenario === "cold-cache") {
    return {
      proxy: "",
      sources: [
        {
          source: { url: "http://a.test/c.json", name: "A", enabled: true },
          entries: null,
          rejected: [],
          error: null,
        },
      ],
    };
  }
  if (scenario === "needs-key") {
    return {
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
          status: "needs_key",
          toolkits: null,
        },
      ],
    };
  }
  return {
    proxy: "",
    sources: [
      {
        source: { url: "http://a.test/c.json", name: "A", enabled: true },
        entries: [
          {
            name: "catalog-alias",
            description: "Aliased plugin",
            author: "acme",
            version: "1.0.0",
            repo: "https://example.com/r.git",
            path: "plugins/real",
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
}

function Fixture() {
  const host = createHost();
  host.state.update((state) => ({ ...state, status: "open" }));
  const scenario = signal<Scenario>("composio-only");
  const settingsClicks = signal(0);
  const stub = Object.assign(host, {
    call: async (
      _target: string,
      method: string,
      args?: { mode?: string; name?: string },
    ) => {
      if (method === "marketCatalog") {
        if (scenario() === "cold-cache" && args?.mode !== "cached") {
          return await new Promise<MarketCatalog>(() => {});
        }
        return makeCatalog(scenario());
      }
      if (method === "marketPreview") {
        const preview: MarketPreview = {
          name: args?.name ?? "catalog-alias",
          manifestName: "real-manifest-name",
          version: "1.0.0",
          description: "Aliased plugin",
          repo: "https://example.com/r.git",
          path: "plugins/real",
          sha: "a".repeat(40),
          requires: [],
          servers: [
            {
              name: "srv",
              transport: "stdio",
              command: ["node", "index.js"],
              fixedEnv: {},
              cwd: null,
              env: [],
              missingEnv: ["SERVICE_API_KEY"],
              headers: [],
              plainHttp: false,
              problem: null,
            },
          ],
          skills: [],
          proxy: null,
          reports: [],
          layout: null,
          fields: [],
        };
        return preview;
      }
      if (method === "composioConnected") return { status: "ready", slugs: [] };
      if (method === "composioAdded") return { slugs: [] };
      return {};
    },
    action: async <T,>(run: () => Promise<T>) => await run(),
  });
  return (
    <Host.Provider value={stub}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row" }}>
          <Button
            label="mode-composio-only"
            onPress={() => scenario.set("composio-only")}
          />
          <Button
            label="mode-cold-cache"
            onPress={() => scenario.set("cold-cache")}
          />
          <Button
            label="mode-needs-key"
            onPress={() => scenario.set("needs-key")}
          />
          <Button
            label="mode-manifest-diff"
            onPress={() => scenario.set("manifest-diff")}
          />
        </View>
        <Label>{`settings-clicks:${settingsClicks()}`}</Label>
        <Each of={[scenario()]} key={(mode) => mode}>
          {() => (
            <Market
              layout="desktop"
              tabs={() => <Label>tabs</Label>}
              onSettings={() => settingsClicks.update((n) => n + 1)}
            />
          )}
        </Each>
      </View>
    </Host.Provider>
  );
}

mount(() => <Fixture />);
