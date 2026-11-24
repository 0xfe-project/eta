import type { MarketSettings } from "@eta/client-contracts";
import { mount, View } from "nsh";
import { PluginSettings } from "../../src/pages/settings/plugins";
import { createHost, Host } from "../../src/services/host";

/** A host that keeps the sources and the proxy the way the real one does. */
let settings: MarketSettings = {
  sources: [
    {
      name: "Cursor",
      url: "https://cursor.test/marketplace.json",
      enabled: false,
    },
    { name: "", url: "https://plain.test/marketplace.json", enabled: true },
  ],
  proxy: "",
};
(globalThis as { __calls?: unknown[] }).__calls = [];

function Fixture() {
  const host = createHost();
  host.state.update((state) => ({ ...state, status: "open" }));
  const stub = Object.assign(host, {
    call: async (
      _section: string,
      method: string,
      args: Record<string, string | boolean>,
    ) => {
      (globalThis as { __calls?: unknown[] }).__calls?.push([method, args]);
      if (method === "marketAddSource")
        settings = {
          ...settings,
          sources: [
            ...settings.sources,
            {
              url: String(args.url),
              name: String(args.name ?? ""),
              enabled: true,
            },
          ],
        };
      if (method === "marketRemoveSource")
        settings = {
          ...settings,
          sources: settings.sources.filter((item) => item.url !== args.url),
        };
      if (method === "marketSetSourceEnabled")
        settings = {
          ...settings,
          sources: settings.sources.map((item) =>
            item.url === args.url
              ? { ...item, enabled: Boolean(args.enabled) }
              : item,
          ),
        };
      if (method === "marketSetProxy")
        settings = {
          ...settings,
          proxy: args.proxy ? String(args.proxy).replace(/\/*$/, "/") : "",
        };
      return settings;
    },
    action: async <T,>(run: () => Promise<T>) => await run(),
  });
  return (
    <Host.Provider value={stub}>
      <View style={{ flex: 1 }}>
        <PluginSettings />
      </View>
    </Host.Provider>
  );
}
mount(() => <Fixture />);
