import type { ComposioToolkit, MarketCatalog } from "@eta/client-contracts";
import { mount, signal, View } from "nsh";
import { Button, Label } from "../../src/components";
import { Market } from "../../src/pages/plugins/market";
import { createHost, Host } from "../../src/services/host";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
/** 100 Composio toolkits, more than one batch; slugs are `app<i>`. */
const toolkit = (i: number): ComposioToolkit => ({
  kind: "composio",
  slug: "app" + i,
  name: "Toolkit " + String(i).padStart(4, "0"),
  description: "d" + i,
  auth: "oauth",
  authSchemes: [],
  managed: true,
  categories: [],
  logo: null,
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
      toolkits: Array.from({ length: 100 }, (_, i) => toolkit(i)),
      rejected: [],
      error: null,
    },
  ],
};

/**
 * What the host answers when asked, with `logosCached`, for the pictures it kept for toolkits
 * (`{ composio: slug }` entries):
 * "hit": a picture for each, at once. "slow": a picture for each, once the `release` button is pressed. "hang": never.
 * "unknown": unknown for each (a host that does not know the field). "old": the call fails.
 * Every slug asked is counted (`asked <all> distinct <different>`), and every `logo` call of a card
 * (which never answers, so its card stays a letter) is counted as `logo <n>`.
 */
export function mountComposioLogos(
  mode: "hit" | "slow" | "hang" | "unknown" | "old",
) {
  const asked = signal<string[]>([]);
  const logoCalls = signal(0);
  /** The answers of "slow" that wait to be released. */
  const waiting: (() => void)[] = [];
  mount(() => {
    const host = createHost();
    host.state.update((state) => ({ ...state, status: "open" }));
    const stub = Object.assign(host, {
      call: (
        _target: string,
        method: string,
        args?: { entries?: { composio?: string }[] },
      ) => {
        if (method === "marketCatalog")
          return Promise.resolve(
            JSON.parse(JSON.stringify(catalog)) as MarketCatalog,
          );
        if (method === "composioConnected")
          return Promise.resolve({ status: "ready", slugs: [] });
        if (method === "logosCached") {
          const entries = args?.entries ?? [];
          asked.set([
            ...asked(),
            ...entries.map((one) => String(one.composio)),
          ]);
          if (mode === "old")
            return Promise.reject(
              new Error("unknown action plugins.logosCached"),
            );
          if (mode === "hang") return new Promise(() => undefined);
          const answer = {
            logos: entries.map(() =>
              mode === "unknown"
                ? { status: "unknown" }
                : { status: "hit", type: "image/png", data: PNG },
            ),
          };
          return mode === "slow"
            ? new Promise((done) => waiting.push(() => done(answer)))
            : Promise.resolve(answer);
        }
        if (method === "logo") {
          logoCalls.set(logoCalls() + 1);
          return new Promise(() => undefined);
        }
        return Promise.resolve({});
      },
      action: async <T,>(run: () => Promise<T>) => await run(),
    });
    return (
      <Host.Provider value={stub}>
        <View style={{ flex: 1 }}>
          <Label>{`asked ${asked().length} distinct ${new Set(asked()).size}`}</Label>
          <Label>{`logo ${logoCalls()}`}</Label>
          <Button
            label="release"
            onPress={() => waiting.splice(0).forEach((go) => go())}
          />
          <Market
            onSettings={() => {}}
            layout="desktop"
            tabs={() => <Label>tabs</Label>}
          />
        </View>
      </Host.Provider>
    );
  });
}
