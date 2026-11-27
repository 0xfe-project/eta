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
          name: "with-author",
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
          sourceName: "A",
        },
        {
          name: "blank-author",
          description: "d",
          author: "  ",
          version: "2.0.0",
          repo: "https://example.com/r.git",
          path: "",
          rev: "a".repeat(40),
          homepage: null,
          requires: [],
          installed: "no",
          unsupported: null,
          source: "http://a.test/c.json",
          sourceName: "A",
        },
        {
          name: "no-author",
          description: "d",
          author: "",
          version: "3.0.0",
          repo: "https://example.com/r.git",
          path: "",
          rev: "a".repeat(40),
          homepage: null,
          requires: [],
          installed: "no",
          unsupported: null,
          source: "http://a.test/c.json",
          sourceName: "A",
        },
        {
          name: "bare",
          description: "d",
          author: "  ",
          version: "",
          repo: "https://example.com/r.git",
          path: "",
          rev: "a".repeat(40),
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

function Fixture() {
  const host = createHost();
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
