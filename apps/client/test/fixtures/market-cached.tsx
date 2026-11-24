import type { MarketCatalog } from "@eta/client-contracts";
import { mount, View } from "nsh";
import { Label } from "../../src/components";
import { Market } from "../../src/pages/plugins/market";
import { createHost, Host } from "../../src/services/host";

const kept: MarketCatalog = {
  proxy: "",
  sources: [
    {
      source: { url: "http://a.test/c.json", name: "Alpha", enabled: true },
      entries: [
        {
          name: "kept-entry",
          description: "d",
          author: "t",
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
        },
      ],
      rejected: [],
      error: null,
      updatedAt: 1_700_000_000_000,
    },
  ],
};

/** The host kept a catalog: "cached" answers at once; the read that asks the servers never answers. */
function Fixture() {
  const host = createHost();
  host.state.update((state) => ({ ...state, status: "open" }));
  const stub = Object.assign(host, {
    call: (_target: string, _action: string, args?: { mode?: string }) =>
      args?.mode === "cached"
        ? Promise.resolve(kept)
        : new Promise<MarketCatalog>(() => undefined),
    action: async <T,>(run: () => Promise<T>) => await run(),
  });
  return (
    <Host.Provider value={stub}>
      <View style={{ flex: 1 }}>
        <Market layout="desktop" tabs={() => <Label>tabs</Label>} />
      </View>
    </Host.Provider>
  );
}
mount(() => <Fixture />);
