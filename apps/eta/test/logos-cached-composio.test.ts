/**
 * `logosCached` for Composio toolkits: the host answers from what it keeps under the toolkit's logo
 * address (memory and database), asks no server, and treats the bytes it reads back as untrusted.
 * Local fake servers only.
 */
import type { AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { IconCache } from "../src/plugins/icon-cache";
import { Logos, MAX_CACHED_LOGOS } from "../src/plugins/logo";
import { pluginsPlugin } from "../src/plugins/plugin";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const REPO = "https://github.com/acme/plugins";
/** Where `Logos.fromUrl` keeps what it found: a pseudo repository, the address as ref and path. */
const KEPT = "#composio";
const later = Date.now() + 3_600_000;
const servers: http.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    server.close();
  }
});

/** A server that takes the request and never answers; what it was asked is counted. */
async function stalled(): Promise<{ base: string; hits: () => number }> {
  let hits = 0;
  const server = http.createServer(() => void hits++);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits: () => hits,
  };
}

function boot() {
  const db = openDatabase(":memory:");
  applyMigrations(db, loadMigrations());
  const store = new IconCache(db);
  return { store, logos: new Logos({ allowPrivate: true, store }) };
}
const keep = (
  store: IconCache,
  address: string,
  picture: { mime: string; bytes: Uint8Array } | null,
  until = later,
) => store.put(KEPT, address, address, picture, until, Date.now());

describe("cached logos for the logo address of a Composio toolkit", () => {
  it("answers hit for a kept picture, miss for a kept none, unknown for the rest, and asks no server", async () => {
    const net = await stalled();
    const { store, logos } = boot();
    keep(store, `${net.base}/hit.png`, { mime: "image/png", bytes: PNG });
    keep(store, `${net.base}/none.png`, null);
    const answer = logos.cached([
      { url: `${net.base}/hit.png` },
      { url: `${net.base}/none.png` },
      { url: `${net.base}/never.png` },
    ]);
    expect(answer.map((one) => one.status)).toEqual(["hit", "miss", "unknown"]);
    expect(answer[0]).toMatchObject({ logo: { type: "image/png" } });
    expect(net.hits()).toBe(0);
    expect(logos.requests).toBe(0);
  });

  it("is unknown for an empty address (a toolkit with no logo address), without a look", () => {
    const { logos } = boot();
    expect(logos.cached([{ url: "" }])).toEqual([{ status: "unknown" }]);
  });

  it("is unknown for a none that has expired, and still a hit for a picture past its time", () => {
    const { store, logos } = boot();
    keep(store, "https://a.test/old-none", null, Date.now() - 1000);
    keep(
      store,
      "https://a.test/old-pic",
      { mime: "image/png", bytes: PNG },
      Date.now() - 1000,
    );
    expect(
      logos
        .cached([
          { url: "https://a.test/old-none" },
          { url: "https://a.test/old-pic" },
        ])
        .map((one) => one.status),
    ).toEqual(["unknown", "hit"]);
  });

  it("does not trust what it reads back: a row that is no picture, or an unsafe SVG, is unknown", () => {
    const { store, logos } = boot();
    keep(store, "https://a.test/text", {
      mime: "image/png",
      bytes: Buffer.from("hello"),
    });
    keep(store, "https://a.test/script", {
      mime: "image/svg+xml",
      bytes: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>',
      ),
    });
    keep(store, "https://a.test/svg", {
      mime: "image/svg+xml",
      bytes: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8z"/></svg>',
      ),
    });
    expect(
      logos
        .cached([
          { url: "https://a.test/text" },
          { url: "https://a.test/script" },
          { url: "https://a.test/svg" },
        ])
        .map((one) => one.status),
    ).toEqual(["unknown", "unknown", "hit"]);
  });

  it("answers repository entries and addresses in one call, in order, under one limit", () => {
    const { store, logos } = boot();
    store.put(
      REPO,
      "HEAD",
      "p/a",
      { mime: "image/png", bytes: PNG },
      later,
      Date.now(),
    );
    keep(store, "https://a.test/b", { mime: "image/png", bytes: PNG });
    const mixed = logos.cached([
      { url: "https://a.test/b" },
      { repo: REPO, ref: "HEAD", path: "p/a", homepage: null },
      { repo: REPO, ref: "HEAD", path: "p/none", homepage: null },
      { url: "https://a.test/none" },
    ]);
    expect(mixed.map((one) => one.status)).toEqual([
      "hit",
      "hit",
      "unknown",
      "unknown",
    ]);
    const many = logos.cached(
      Array.from({ length: MAX_CACHED_LOGOS + 5 }, () => ({
        url: "https://a.test/b",
      })),
    );
    expect(
      many.slice(0, MAX_CACHED_LOGOS).every((one) => one.status === "hit"),
    ).toBe(true);
    expect(
      many.slice(MAX_CACHED_LOGOS).every((one) => one.status === "unknown"),
    ).toBe(true);
  });
});

describe("plugins.logosCached with a Composio toolkit as the entry", () => {
  function handler(logoOf: (slug: string) => string | null, store: IconCache) {
    const handlers = new Map<string, (call: unknown) => unknown>();
    const wire = new Proxy(
      {
        handle: (target: string, action: string, run: never) => {
          handlers.set(`${target}.${action}`, run);
          return () => {};
        },
      } as Record<string, unknown>,
      { get: (self, key: string) => self[key] ?? (() => () => {}) },
    );
    pluginsPlugin(
      {
        plugins: {} as never,
        agents: {} as never,
        market: {} as never,
        composio: { logoOf } as never,
        icons: store,
      },
      () => {},
    ).apply({ wire, sessions: {}, effect: (run: () => unknown) => run() });
    const run = handlers.get("plugins.logosCached")!;
    return (entries: unknown[]) =>
      run({ target: "plugins", action: "logosCached", args: { entries } }) as {
        result: { logos: { status: string; type?: string; data?: string }[] };
      };
  }

  it("answers hit from the address the host lists for the slug, unknown for no address or nothing kept, and asks no server", async () => {
    const net = await stalled();
    const { store } = boot();
    keep(store, `${net.base}/github.png`, { mime: "image/png", bytes: PNG });
    const addresses: Record<string, string> = {
      github: `${net.base}/github.png`,
      fresh: `${net.base}/fresh.png`,
    };
    const ask = handler((slug) => addresses[slug] ?? null, store);
    const { logos } = ask([
      { composio: "github" },
      { composio: "no-address" },
      { composio: "fresh" },
    ]).result;
    expect(logos).toEqual([
      { status: "hit", type: "image/png", data: PNG.toString("base64") },
      { status: "unknown" },
      { status: "unknown" },
    ]);
    expect(net.hits()).toBe(0);
  });

  it("still answers repository entries, and a composio field that is no string is not an entry", () => {
    const { store } = boot();
    store.put(
      REPO,
      "HEAD",
      "p/a",
      { mime: "image/png", bytes: PNG },
      later,
      Date.now(),
    );
    const ask = handler(() => null, store);
    const { logos } = ask([
      { repo: REPO, ref: "HEAD", path: "p/a" },
      { composio: 5 },
      {},
    ]).result;
    expect(logos.map((one) => one.status)).toEqual([
      "hit",
      "unknown",
      "unknown",
    ]);
  });
});
