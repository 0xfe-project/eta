import type { MarketCatalog } from "@eta/client-contracts";
import { mount, View } from "nsh";
import { Label } from "../../src/components";
import { Market } from "../../src/pages/plugins/market";
import { createHost, Host } from "../../src/services/host";

const several: MarketCatalog = {
  proxy: "",
  sources: [
    {
      source: { url: "http://a.test/c.json", name: "Alpha", enabled: true },
      entries: [
        {
          name: "shared-name",
          description: "d",
          author: "t",
          version: "1.0.0",
          repo: "https://example.com/r.git",
          path: "",
          rev: "a".repeat(40),
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
    },
    {
      source: { url: "http://down.test/c.json", name: "Down", enabled: true },
      entries: null,
      rejected: [],
      error: "cannot read the catalog: HTTP 404",
    },
    {
      source: { url: "http://b.test/c.json", name: "Beta", enabled: true },
      entries: [
        {
          name: "shared-name",
          description: "d",
          author: "t",
          version: "2.0.0",
          repo: "https://example.com/r.git",
          path: "",
          rev: "a".repeat(40),
          homepage: null,
          requires: [],
          installed: "no",
          unsupported: null,
          source: "http://b.test/c.json",
          sourceName: "Beta",
        },
      ],
      rejected: [],
      error: null,
    },
  ],
};

function Fixture() {
  const host = createHost();
  const catalog = several;
  host.state.update((state) => ({ ...state, status: "open" }));
  const stub = Object.assign(host, {
    call: async () => catalog,
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
