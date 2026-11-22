import type { MarketCatalog } from "@eta/client-contracts";
import { mount, View } from "nsh";
import { Label } from "../../src/components";
import { Market } from "../../src/pages/plugins/market";
import { createHost, Host } from "../../src/services/host";

const empty: MarketCatalog = {
  url: "",
  isDefault: true,
  entries: null,
  rejected: [],
  error: "no catalog address is set",
};
const full: MarketCatalog = {
  url: "http://catalog.test/c.json",
  isDefault: false,
  entries: [
    {
      name: "hello-plugin",
      description: "<b>Says hello</b>",
      author: "t",
      version: "1.0.0",
      repo: "https://example.com/r.git",
      path: "",
      rev: "a".repeat(40),
      homepage: null,
      requires: [],
      installed: "this",
      unsupported: null,
    },
  ],
  rejected: [{ index: 2, name: "bad", reason: "rev is missing" }],
  error: null,
};

function Fixture() {
  const host = createHost();
  const catalog = (globalThis as { __catalog?: string }).__catalog === "full" ? full : empty;
  host.state.update((state) => ({ ...state, status: "open" }));
  const stub = Object.assign(host, {
    call: async () => catalog,
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
