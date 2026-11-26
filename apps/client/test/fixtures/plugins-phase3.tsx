import type {
  MarketCatalog,
  MarketPreview,
  PluginBundledAgentView,
  PluginView,
} from "@eta/client-contracts";
import { mount, signal, View } from "nsh";
import { Button, Label } from "../../src/components";
import { Market } from "../../src/pages/plugins/market";
import { Plugins } from "../../src/pages/plugins/plugins";
import { createHost, Host } from "../../src/services/host";

const codeReviewer: PluginBundledAgentView = {
  id: "code-reviewer",
  name: "Code Reviewer",
  description: "Reviews pull requests for bugs and regressions.",
  path: "agents/code-reviewer.md",
  instructions: "Inspect diffs carefully and flag concrete defects.",
};

const securityAuditor: PluginBundledAgentView = {
  id: "security-auditor",
  name: "Security Auditor",
  description: "",
  path: "agents/security-auditor.md",
  instructions: "Check for injection, auth bypasses, and secret leaks.",
};

const bundledPlugin: PluginView = {
  name: "bundle-plugin",
  version: "1.2.0",
  description: "Plugin shipping reusable bots.",
  source: { kind: "local", path: "/p/bundle-plugin" },
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
  env: [],
  agents: [],
  bundledAgents: [codeReviewer, securityAuditor],
};

const plainPlugin: PluginView = {
  name: "plain-plugin",
  version: "1.0.0",
  description: "Plugin without bundled agents.",
  source: { kind: "local", path: "/p/plain-plugin" },
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
  env: [],
  agents: [],
};

const marketCatalog: MarketCatalog = {
  proxy: "",
  sources: [
    {
      source: {
        url: "https://example.com/catalog.json",
        name: "Catalog",
        enabled: true,
      },
      entries: [
        {
          name: "market-with-bots",
          description: "Marketplace plugin with bundled bots",
          author: "acme",
          version: "2.0.0",
          repo: "https://example.com/bots.git",
          path: ".",
          rev: "b".repeat(40),
          homepage: null,
          requires: [],
          installed: "no",
          unsupported: null,
          source: "https://example.com/catalog.json",
          sourceName: "Catalog",
        },
        {
          name: "market-no-bots",
          description: "Marketplace plugin without bundled bots",
          author: "acme",
          version: "1.0.0",
          repo: "https://example.com/plain.git",
          path: ".",
          rev: "c".repeat(40),
          homepage: null,
          requires: [],
          installed: "no",
          unsupported: null,
          source: "https://example.com/catalog.json",
          sourceName: "Catalog",
        },
      ],
      rejected: [],
      error: null,
    },
  ],
};

type Mode = "tablet" | "tablet-readonly" | "desktop" | "market";

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
          list: [bundledPlugin, plainPlugin],
          audit: [],
        },
      },
    },
  }));
  const mode = signal<Mode>("tablet");
  const imported = signal("");
  const stub = Object.assign(host, {
    call: async (_target: string, method: string, args?: { name?: string }) => {
      if (method === "marketCatalog") return marketCatalog;
      if (method === "marketPreview") {
        if (args?.name === "market-with-bots") {
          const preview: MarketPreview = {
            name: "market-with-bots",
            version: "2.0.0",
            description: "Marketplace plugin with bundled bots",
            repo: "https://example.com/bots.git",
            path: ".",
            sha: "b".repeat(40),
            requires: [],
            servers: [],
            skills: [],
            proxy: null,
            reports: [],
            layout: null,
            fields: [],
            bundledAgents: [
              {
                id: "release-bot",
                name: "Release Bot",
                description: "Automates <release> notes & checklists.",
                path: "agents/release-bot.md",
                instructions: "Draft release notes.",
              },
              {
                id: "triage-bot",
                name: "Triage Bot",
                description: "",
                path: "agents/triage-bot.md",
                instructions: "Triage incoming issues.",
              },
            ],
          };
          return preview;
        }
        const emptyPreview: MarketPreview = {
          name: args?.name ?? "market-no-bots",
          version: "1.0.0",
          description: "Marketplace plugin without bundled bots",
          repo: "https://example.com/plain.git",
          path: ".",
          sha: "c".repeat(40),
          requires: [],
          servers: [],
          skills: [],
          proxy: null,
          reports: [],
          layout: null,
          fields: [],
        };
        return emptyPreview;
      }
      return {};
    },
    action: async <T,>(run: () => Promise<T>) => await run(),
  });
  const onImportAgent = (pluginName: string, agent: PluginBundledAgentView) => {
    imported.set(
      `imported:${pluginName}:${agent.id}:${agent.name}:${agent.path}:${agent.instructions}`,
    );
  };
  return (
    <Host.Provider value={stub}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row" }}>
          <Button label="mode-tablet" onPress={() => mode.set("tablet")} />
          <Button
            label="mode-tablet-readonly"
            onPress={() => mode.set("tablet-readonly")}
          />
          <Button label="mode-desktop" onPress={() => mode.set("desktop")} />
          <Button label="mode-market" onPress={() => mode.set("market")} />
        </View>
        <Label>{imported() || "imported:none"}</Label>
        <Each of={[mode()]} key={(m) => m}>
          {(current) => (
            <If
              when={current() === "market"}
              else={
                <Plugins
                  layout={current() === "desktop" ? "desktop" : "tablet"}
                  onImportAgent={
                    current() === "tablet-readonly" ? undefined : onImportAgent
                  }
                />
              }
            >
              <Market layout="desktop" tabs={() => <Label>tabs</Label>} />
            </If>
          )}
        </Each>
      </View>
    </Host.Provider>
  );
}

mount(() => <Fixture />);
