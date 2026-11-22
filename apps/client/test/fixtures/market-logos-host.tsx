import type { MarketCatalog } from "@eta/client-contracts";
import { mount, View } from "nsh";
import { Label } from "../../src/components";
import { Market } from "../../src/pages/plugins/market";
import { createHost, Host } from "../../src/services/host";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const entry = (name: string, path: string) => ({
  name,
  description: "d",
  author: "t",
  version: "1.0.0",
  repo: "https://github.com/acme/plugins",
  path,
  rev: null,
  homepage: null,
  requires: [],
  installed: "no" as const,
  unsupported: null,
  source: "http://a.test/c.json",
  sourceName: "Alpha",
});
const kept: MarketCatalog = {
  proxy: "",
  sources: [
    {
      source: { url: "http://a.test/c.json", name: "Alpha", enabled: true },
      entries: [
        entry("kept-entry", "p/kept"),
        entry("no-logo", "p/none"),
        entry("unknown-one", "p/unknown"),
      ],
      rejected: [],
      error: null,
      updatedAt: 1_700_000_000_000,
    },
  ],
};

/**
 * "hit": logosCached answers a picture for the first, a known miss for the second, unknown for the third.
 * "stalled": logosCached never answers. "old": the host has no such call (it throws). Every `logo`
 * call is counted in `__logoCalls` and never answers, so a card that asks for its own stays a letter.
 */
export function mountMarket(mode: "hit" | "stalled" | "old") {
  (globalThis as { __logoCalls?: string[] }).__logoCalls = [];
  function Fixture() {
    const host = createHost();
    host.state.update((state) => ({ ...state, status: "open" }));
    const stub = Object.assign(host, {
      call: (
        _target: string,
        action: string,
        args?: { mode?: string; path?: string },
      ) => {
        if (action === "marketCatalog")
          return args?.mode === "cached"
            ? Promise.resolve(kept)
            : new Promise<MarketCatalog>(() => undefined);
        if (action === "logosCached") {
          if (mode === "old")
            return Promise.reject(
              new Error("unknown action plugins.logosCached"),
            );
          if (mode === "stalled") return new Promise(() => undefined);
          return Promise.resolve({
            logos: [
              { status: "hit", type: "image/png", data: PNG },
              { status: "miss" },
              { status: "unknown" },
            ],
          });
        }
        if (action === "logo") {
          (globalThis as { __logoCalls?: string[] }).__logoCalls?.push(
            String(args?.path),
          );
          return new Promise(() => undefined);
        }
        return Promise.resolve(undefined);
      },
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
}
