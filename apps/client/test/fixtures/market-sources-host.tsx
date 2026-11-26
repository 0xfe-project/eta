import type { MarketCatalog } from "@eta/client-contracts";
import { mount, signal, View } from "nsh";
import { Button, Label } from "../../src/components";
import { Market } from "../../src/pages/plugins/market";
import { createHost, Host } from "../../src/services/host";

const entry = (
  name: string,
  source: string,
  sourceName: string,
  version: string,
) => ({
  name,
  description: "d",
  author: "t",
  version,
  repo: "",
  path: "",
  rev: null,
  homepage: null,
  requires: [],
  installed: "no" as const,
  unsupported: null,
  source,
  sourceName,
});
const A = "http://a.test/c.json";
const B = "http://b.test/c.json";
const part = (
  url: string,
  name: string,
  entries: ReturnType<typeof entry>[],
  updatedAt: number,
) => ({
  source: { url, name, enabled: true },
  entries,
  rejected: [],
  error: null,
  updatedAt,
});
const kept: MarketCatalog = {
  proxy: "",
  sources: [
    part(
      A,
      "Alpha",
      [entry("alpha-old", A, "Alpha", "1.0.0")],
      1_700_000_000_000,
    ),
    part(
      B,
      "Beta",
      [entry("beta-kept", B, "Beta", "1.0.0")],
      1_700_000_000_000,
    ),
  ],
};
const alphaFresh = part(
  A,
  "Alpha",
  [entry("alpha-new", A, "Alpha", "2.0.0")],
  1_800_000_000_000,
);

/**
 * "split": the host's kept list answers at once; Alpha's read answers with a new entry; Beta's read
 * never answers. "fail": Beta's read fails. "reopen": the market is closed and opened again, and the
 * second kept-list call never answers (so only what the first showed can be on screen).
 */
export function mountSources(mode: "split" | "fail" | "reopen") {
  let cachedCalls = 0;
  function Fixture() {
    const host = createHost();
    host.state.update((state) => ({ ...state, status: "open" }));
    const open = signal(true);
    const stub = Object.assign(host, {
      call: (
        _target: string,
        _action: string,
        args?: { mode?: string; source?: string },
      ) => {
        if (args?.mode === "cached") {
          cachedCalls++;
          return mode === "reopen" && cachedCalls > 1
            ? new Promise<MarketCatalog>(() => undefined)
            : Promise.resolve(kept);
        }
        // Alpha answers a little later, so the first frame is what the host kept.
        if (args?.source === A)
          return new Promise<MarketCatalog>((done) =>
            setTimeout(() => done({ proxy: "", sources: [alphaFresh] }), 2000),
          );
        if (args?.source === B)
          return mode === "fail"
            ? Promise.reject(new Error("down"))
            : new Promise<MarketCatalog>(() => undefined);
        return new Promise<MarketCatalog>(() => undefined);
      },
      action: async <T,>(run: () => Promise<T>) => {
        try {
          return await run();
        } catch {
          return undefined;
        }
      },
    });
    return (
      <Host.Provider value={stub}>
        <View style={{ flex: 1 }}>
          <Button
            label="Toggle market"
            tone="plain"
            labelVariant="body"
            size={28}
            onPress={() => open.set(!open())}
          />
          <If when={open()} else={<Label>closed</Label>}>
            <Market
              onSettings={() => {}}
              layout="desktop"
              tabs={() => <Label>tabs</Label>}
            />
          </If>
        </View>
      </Host.Provider>
    );
  }
  mount(() => <Fixture />);
}
