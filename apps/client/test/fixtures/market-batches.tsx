import type { ComposioToolkit, MarketCatalog } from "@eta/client-contracts";
import { mount, signal, View } from "nsh";
import { Label } from "../../src/components";
import { Market } from "../../src/pages/plugins/market";
import { createHost, Host } from "../../src/services/host";

/** More toolkits than one batch: 130. `logos:n` is how many distinct pictures the host was asked for. */
const COUNT = 130;
const toolkit = (i: number): ComposioToolkit => ({
  kind: "composio",
  slug: "app" + i,
  name: "Toolkit " + String(i).padStart(4, "0"),
  description: "d" + i,
  auth: "oauth",
  authSchemes: [],
  managed: true,
  categories: [],
  logo: "https://logos.composio.dev/api/app" + i,
  appUrl: null,
  toolsCount: 1,
  source: "composio",
  sourceName: "Composio",
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
      toolkits: Array.from({ length: COUNT }, (_, i) => toolkit(i)),
      rejected: [],
      error: null,
    },
  ],
};

mount(() => {
  const host = createHost();
  host.state.update((state) => ({ ...state, status: "open" }));
  const asked = signal<string[]>([]);
  const stub = Object.assign(host, {
    call: async (
      _target: string,
      method: string,
      args: { composio?: string },
    ) => {
      if (method === "marketCatalog")
        return JSON.parse(JSON.stringify(catalog)) as MarketCatalog;
      if (method === "composioConnected") return { status: "ready", slugs: [] };
      if (method === "logo") {
        asked.update((all) => [...all, String(args.composio)]);
        return null;
      }
      return {};
    },
    action: async <T,>(run: () => Promise<T>) => await run(),
  });
  return (
    <Host.Provider value={stub}>
      <View style={{ flex: 1 }}>
        <Label>
          {"logos:" + new Set(asked()).size + " calls:" + asked().length}
        </Label>
        <Market
          onSettings={() => {}}
          layout="desktop"
          tabs={() => <Label>tabs</Label>}
        />
      </View>
    </Host.Provider>
  );
});
