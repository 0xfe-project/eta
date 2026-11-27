import type { MarketCatalog } from "@eta/client-contracts";
import { mount, View } from "nsh";
import { Label } from "../../src/components";
import { Market } from "../../src/pages/plugins/market";
import { createHost, Host } from "../../src/services/host";

/** One card with no marker and one of each marker: installed, name taken, format not supported. */
const markers: MarketCatalog = {
  proxy: "",
  sources: [
    {
      source: { url: "http://a.test/c.json", name: "Alpha", enabled: true },
      entries: [
        {
          name: "plain",
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
        {
          name: "here",
          description: "d",
          author: "t",
          version: "1.0.0",
          repo: "https://example.com/r.git",
          path: "",
          rev: "a".repeat(40),
          homepage: null,
          requires: [],
          installed: "this",
          unsupported: null,
          source: "http://a.test/c.json",
          sourceName: "Alpha",
        },
        {
          name: "taken",
          description: "d",
          author: "t",
          version: "1.0.0",
          repo: "https://example.com/r.git",
          path: "",
          rev: "a".repeat(40),
          homepage: null,
          requires: [],
          installed: "other",
          unsupported: null,
          source: "http://a.test/c.json",
          sourceName: "Alpha",
        },
        {
          name: "bad",
          description: "d",
          author: "t",
          version: "1.0.0",
          repo: "https://example.com/r.git",
          path: "",
          rev: "a".repeat(40),
          homepage: null,
          requires: [],
          installed: "no",
          unsupported: "no plugin file",
          source: "http://a.test/c.json",
          sourceName: "Alpha",
        },
      ],
      rejected: [],
      error: null,
    },
  ],
};

function Fixture() {
  const host = createHost();
  host.state.update((state) => ({ ...state, status: "open" }));
  const stub = Object.assign(host, {
    call: async () => markers,
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
