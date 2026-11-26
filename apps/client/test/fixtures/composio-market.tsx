import type {
  ComposioToolkit,
  MarketCatalog,
  MarketSourceCatalog,
} from "@eta/client-contracts";
import { mount, signal, View } from "nsh";
import { Button, Label } from "../../src/components";
import { Market } from "../../src/pages/plugins/market";
import { createHost, Host } from "../../src/services/host";

const SOURCE = {
  url: "composio",
  name: "Composio",
  enabled: true,
  kind: "composio" as const,
};

function toolkit(
  slug: string,
  name: string,
  auth: ComposioToolkit["auth"],
): ComposioToolkit {
  return {
    kind: "composio",
    slug,
    name,
    description: name + " toolkit",
    auth,
    authSchemes: [],
    managed: true,
    categories: [],
    logo: null,
    appUrl: null,
    toolsCount: 3,
    source: "composio",
    sourceName: "Composio",
  };
}

const composio = (
  patch: Partial<MarketSourceCatalog>,
): MarketSourceCatalog => ({
  source: SOURCE,
  entries: [],
  rejected: [],
  error: null,
  ...patch,
});

/**
 * The market over one catalog; the link answer decides how connecting ends. `connected`: what the
 * host says is connected; `"after-link"` means gmail is connected from the second question after
 * the link was made (so a poll has to ask again); `"never"` that nothing ever is. `polls` shows
 * how many times it was asked, and `leavable` adds a button that takes the market off the screen.
 * `disconnect`: how `composioDisconnect` ends: `ok` (gmail is gone for the next question),
 * `stale` (it is deleted, but the next question about what is connected never answers, so only what the
 * page did by itself can show it gone) or `fails` (a status that says it failed; gmail stays).
 */
export function openMarket(
  catalog: MarketCatalog,
  link: "ok" | "fail" | "no-managed" = "ok",
  options: {
    connected?: "after-link" | "never" | "already";
    leavable?: boolean;
    disconnect?: "ok" | "stale" | "fails";
    /** The toolkits that need no sign-in and were added (what `composioAdded` answers). */
    added?: string[];
  } = {},
) {
  mount(() => {
    const host = createHost();
    host.state.update((state) => ({ ...state, status: "open" }));
    const log = signal<string[]>([]);
    const polls = signal(0);
    const shown = signal(true);
    let linked = false;
    let since = 0;
    let gone = false;
    let added = [...(options.added ?? [])];
    const stub = Object.assign(host, {
      call: async (
        _target: string,
        method: string,
        args: { slug?: string },
      ) => {
        if (method === "marketCatalog")
          return JSON.parse(JSON.stringify(catalog)) as MarketCatalog;
        if (method === "composioConnected") {
          polls.update((n) => n + 1);
          if (gone && options.disconnect === "stale")
            return await new Promise(() => {});
          if (gone) return { status: "ready", slugs: [] };
          if (linked) since++;
          const on =
            options.connected === "already" ||
            (options.connected === "after-link" && linked && since >= 2);
          return { status: "ready", slugs: on ? ["gmail"] : [] };
        }
        if (method === "composioDisconnect") {
          log.update((all) => [...all, "called:" + method + ":" + args.slug]);
          if (options.disconnect === "fails")
            return { status: "error", removed: 0 };
          gone = true;
          return { status: "ready", removed: 1 };
        }
        if (method === "composioAdded") return { slugs: added };
        if (method === "composioAdd") {
          log.update((all) => [...all, "called:" + method + ":" + args.slug]);
          added = [...added, args.slug!];
          return { status: "ready" };
        }
        if (method === "composioRemove") {
          log.update((all) => [...all, "called:" + method + ":" + args.slug]);
          added = added.filter((one) => one !== args.slug);
          return { removed: true };
        }
        if (method === "composioLink") {
          linked = true;
          log.update((all) => [...all, "called:" + method + ":" + args.slug]);
          if (link === "fail") throw new Error("Composio refused the link");
          if (link === "no-managed")
            throw new Error("composio_no_managed_login: no managed sign-in");
          return { redirectUrl: "https://connect.composio.test/" + args.slug };
        }
        return {};
      },
      action: async <T,>(run: () => Promise<T>) => await run(),
    });
    return (
      <Host.Provider value={stub}>
        <View style={{ flex: 1 }}>
          <Label>{log().join(" ")}</Label>
          <Label>{"polls:" + polls()}</Label>
          <If when={options.leavable}>
            <Button label="Leave" onPress={() => shown.set(false)} />
          </If>
          <If when={shown()}>
            <Market
              onSettings={() => {}}
              layout="desktop"
              tabs={() => <Label>tabs</Label>}
              open={async (url) => {
                log.update((all) => [...all, "opened:" + url]);
              }}
            />
          </If>
        </View>
      </Host.Provider>
    );
  });
}

export const readyCatalog: MarketCatalog = {
  proxy: "",
  sources: [
    composio({
      status: "ready",
      entries: [],
      toolkits: [
        toolkit("gmail", "Gmail", "oauth"),
        toolkit("exa", "Exa", "api_key"),
        toolkit("hackernews", "Hacker News", "none"),
      ],
    }),
  ],
};
export const noKeyCatalog = (
  status: "needs_key" | "key_rejected",
): MarketCatalog => ({
  proxy: "",
  sources: [
    composio({ status, toolkits: null }),
    {
      source: { url: "http://a.test/c.json", name: "A", enabled: true },
      entries: [
        {
          name: "one",
          description: "d",
          author: "t",
          version: "1.0.0",
          repo: "https://example.com/r.git",
          path: "plugins/one",
          rev: null,
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
});
