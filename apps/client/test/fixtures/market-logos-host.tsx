import type { MarketCatalog } from "@eta/client-contracts";
import { mount, signal, View } from "nsh";
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
const catalogOf = (entries: ReturnType<typeof entry>[]): MarketCatalog => ({
  proxy: "",
  sources: [
    {
      source: { url: "http://a.test/c.json", name: "Alpha", enabled: true },
      entries,
      rejected: [],
      error: null,
      updatedAt: 1_700_000_000_000,
    },
  ],
});
const kept = catalogOf([
  entry("kept-entry", "p/kept"),
  entry("no-logo", "p/none"),
  entry("unknown-one", "p/unknown"),
]);
/** More entries than one answer may carry: the first is unknown, odd paths are kept, even are misses. */
const MANY = 260;
const many = catalogOf([
  entry("first-unknown", "p/0"),
  ...Array.from({ length: MANY - 2 }, (_, i) =>
    entry(`e${i + 1}`, `p/${i + 1}`),
  ),
  // The same picture under another name: asked about once.
  entry("twin", "p/1"),
]);

/**
 * "hit": logosCached answers a picture for the first, a known miss for the second, unknown for the third.
 * "stalled": logosCached never answers. "old": the host has no such call (it throws). Every `logo`
 * call is shown as `logo <path>` and never answers, so a card that asks for its own stays a letter.
 * "many": a market of ${MANY} entries; the sizes of the `logosCached` calls are shown as `batches a+b+…`.
 */
export function mountMarket(mode: "hit" | "stalled" | "old" | "many") {
  const batches = signal<number[]>([]);
  const logoPaths = signal<string[]>([]);
  function Fixture() {
    const host = createHost();
    host.state.update((state) => ({ ...state, status: "open" }));
    const stub = Object.assign(host, {
      call: (
        _target: string,
        action: string,
        args?: {
          mode?: string;
          path?: string;
          entries?: { path: string }[];
        },
      ) => {
        if (action === "marketCatalog")
          return args?.mode === "cached"
            ? Promise.resolve(mode === "many" ? many : kept)
            : new Promise<MarketCatalog>(() => undefined);
        if (action === "logosCached") {
          if (mode === "old")
            return Promise.reject(
              new Error("unknown action plugins.logosCached"),
            );
          if (mode === "stalled") return new Promise(() => undefined);
          if (mode === "many") {
            const asked = args?.entries ?? [];
            batches.set([...batches(), asked.length]);
            return Promise.resolve({
              logos: asked.map((one) =>
                one.path === "p/0"
                  ? { status: "unknown" }
                  : Number(one.path.slice(2)) % 2 === 1
                    ? { status: "hit", type: "image/png", data: PNG }
                    : { status: "miss" },
              ),
            });
          }
          return Promise.resolve({
            logos: [
              { status: "hit", type: "image/png", data: PNG },
              { status: "miss" },
              { status: "unknown" },
            ],
          });
        }
        if (action === "logo") {
          logoPaths.set([...logoPaths(), String(args?.path)]);
          return new Promise(() => undefined);
        }
        return Promise.resolve(undefined);
      },
      action: async <T,>(run: () => Promise<T>) => await run(),
    });
    return (
      <Host.Provider value={stub}>
        <View style={{ flex: 1 }}>
          <Label>{`batches ${batches().join("+")}`}</Label>
          <Label>{`logo ${logoPaths().join(",")}`}</Label>
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
}
