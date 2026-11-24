/**
 * The market's catalog cache against a local server that counts its requests: nothing reaches the
 * network. A "restart" is a second `Market` on the same database.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { githubProxy } from "../src/plugins/git";
import { Market } from "../src/plugins/market";
import { CatalogCache } from "../src/plugins/market-cache";
import { SettingStore } from "../src/settings/store";

const BODY = JSON.stringify({
  plugins: [{ name: "demo", description: "d", source: "./demo" }],
});
let requests: Request[];
let handler: (request: Request) => Response;
let server: ReturnType<typeof Bun.serve>;

beforeEach(() => {
  githubProxy.prefix = "";
  requests = [];
  handler = (request) =>
    request.headers.get("if-none-match") === '"v1"'
      ? new Response(null, { status: 304 })
      : new Response(BODY, {
          headers: { etag: '"v1"', "content-type": "application/json" },
        });
  server = Bun.serve({
    port: 0,
    fetch: (request) => {
      requests.push(request);
      return handler(request);
    },
  });
});
afterEach(async () => {
  await server.stop(true);
});

const address = (path = "catalog.json") =>
  `http://127.0.0.1:${server.port}/${path}`;

function open() {
  const db = openDatabase(":memory:");
  applyMigrations(db, loadMigrations());
  const start = (url = address(), cap: { maxRows?: number } = {}) => {
    const settings = new SettingStore(db);
    const market = new Market({
      settings,
      plugins: {} as never,
      dataDir: "unused",
      schemes: ["https:", "file:"],
      cache: new CatalogCache(db, { maxRowBytes: 1024 * 1024, ...cap }),
    });
    for (const source of market.sources()) market.removeSource(source.url);
    market.addSource(url, "");
    return market;
  };
  return { db, start };
}

describe("the catalog cache", () => {
  it("is empty at first, and a read fills it", async () => {
    const { start } = open();
    const market = start();
    const none = (await market.catalog("cached")).sources[0]!;
    expect(none).toMatchObject({ entries: null, error: null, updatedAt: null });
    expect(requests).toHaveLength(0);
    const read = (await market.catalog()).sources[0]!;
    expect(read.entries?.map((entry) => entry.name)).toEqual(["demo"]);
    expect(read.updatedAt).toBeGreaterThan(0);
  });

  it("serves a kept catalog after a restart with no request, with its age", async () => {
    const { start } = open();
    await start().catalog();
    expect(requests).toHaveLength(1);
    const again = (await start().catalog("cached")).sources[0]!;
    expect(again.entries?.map((entry) => entry.name)).toEqual(["demo"]);
    expect(again.updatedAt).toBeGreaterThan(0);
    expect(requests).toHaveLength(1);
  });

  it("asks the server first with the validator it kept, and takes 304 as unchanged", async () => {
    const { start } = open();
    const market = start();
    await market.catalog();
    const before = (await market.catalog("cached")).sources[0]!.updatedAt!;
    await new Promise((done) => setTimeout(done, 5));
    const second = (await market.catalog()).sources[0]!;
    expect(requests[1]!.headers.get("if-none-match")).toBe('"v1"');
    expect(second.entries?.map((entry) => entry.name)).toEqual(["demo"]);
    expect(second.stale).toBeNull();
    expect(second.updatedAt!).toBeGreaterThan(before);
  });

  it("keeps the old catalog and says why when reading again fails", async () => {
    const { start } = open();
    const market = start();
    await market.catalog();
    handler = () => new Response("down", { status: 503 });
    const failed = (await market.catalog()).sources[0]!;
    expect(failed.entries?.map((entry) => entry.name)).toEqual(["demo"]);
    expect(failed.error).toBeNull();
    expect(failed.stale).toContain("503");
    expect(failed.updatedAt).toBeGreaterThan(0);
  });

  it("shows the error only when nothing is kept", async () => {
    const { start } = open();
    handler = () => new Response("down", { status: 503 });
    const failed = (await start().catalog()).sources[0]!;
    expect(failed.entries).toBeNull();
    expect(failed.error).toContain("503");
  });

  it("is not changed by an answer that is not a catalog", async () => {
    const { start } = open();
    const market = start();
    await market.catalog();
    handler = () => new Response("{not json", { headers: { etag: '"v2"' } });
    const bad = (await market.catalog()).sources[0]!;
    expect(bad.stale).toContain("JSON");
    handler = () =>
      new Response(JSON.stringify({ nope: 1 }), { headers: { etag: '"v3"' } });
    expect((await market.catalog()).sources[0]!.stale).toContain("plugins");
    const kept = (await market.catalog("cached")).sources[0]!;
    expect(kept.entries?.map((entry) => entry.name)).toEqual(["demo"]);
  });

  it("is keyed by the address: another address starts empty", async () => {
    const { start } = open();
    await start().catalog();
    const other = (await start(address("other.json")).catalog("cached"))
      .sources[0]!;
    expect(other).toMatchObject({ entries: null, error: null });
  });

  it("checks a kept row again on read: a bad shape or a too-big text is dropped", async () => {
    const { db, start } = open();
    const url = address();
    const row = (body: string) =>
      db
        .query(
          "INSERT OR REPLACE INTO market_catalog_cache (url, body, etag, last_modified, fetched_at, used_at, size) VALUES (?, ?, NULL, NULL, 1, 1, ?)",
        )
        .run(url, body, body.length);
    row('{"plugins": "x"}');
    expect((await start().catalog("cached")).sources[0]!.entries).toBeNull();
    expect(
      db.query("SELECT COUNT(*) AS n FROM market_catalog_cache").get(),
    ).toEqual({ n: 0 });
    row(JSON.stringify({ plugins: [], pad: "x".repeat(2000) }));
    const small = openDatabase(":memory:");
    applyMigrations(small, loadMigrations());
    const cache = new CatalogCache(small, { maxRowBytes: 100 });
    cache.put(url, "x".repeat(200), null, null, 1);
    expect(cache.get(url, 2)).toBeUndefined();
  });

  it("drops the least recently used rows over the cap, and can be cleared", async () => {
    const { db } = open();
    const cache = new CatalogCache(db, { maxRowBytes: 1000, maxRows: 2 });
    cache.put("a", "{}", null, null, 1);
    cache.put("b", "{}", null, null, 2);
    cache.get("a", 3);
    cache.put("c", "{}", null, null, 4);
    expect(cache.get("a", 5)).toBeDefined();
    expect(cache.get("b", 5)).toBeUndefined();
    expect(cache.get("c", 5)).toBeDefined();
    expect(cache.clear()).toBe(2);
    expect(cache.get("a", 6)).toBeUndefined();
  });
});

describe("sources read on their own", () => {
  /** Two sources: the test server, and one that takes the request and never answers. */
  function two() {
    const { db } = open();
    const hang = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => undefined),
    });
    const market = new Market({
      settings: new SettingStore(db),
      plugins: {} as never,
      dataDir: "unused",
      schemes: ["https:", "file:"],
      cache: new CatalogCache(db, { maxRowBytes: 1024 * 1024 }),
    });
    for (const source of market.sources()) market.removeSource(source.url);
    const slow = `http://127.0.0.1:${hang.port}/slow.json`;
    market.addSource(address(), "Fast");
    market.addSource(slow, "Slow");
    return { market, slow, stop: () => hang.stop(true) };
  }

  it("reads only the source asked for, so a slow one holds nothing back", async () => {
    const { market, slow, stop } = two();
    try {
      const fast = await market.catalog("refresh", address());
      expect(fast.sources).toHaveLength(1);
      expect(fast.sources[0]!.entries?.map((entry) => entry.name)).toEqual([
        "demo",
      ]);
      expect(requests).toHaveLength(1);
      expect(slow).not.toBe(address());
    } finally {
      await stop();
    }
  });

  it("answers the kept lists at once even when a source's server never answers", async () => {
    const { market, stop } = two();
    try {
      await market.catalog("refresh", address());
      const started = performance.now();
      const kept = await market.catalog("cached");
      expect(performance.now() - started).toBeLessThan(200);
      expect(kept.sources.map((item) => item.entries !== null)).toEqual([
        true,
        false,
      ]);
      expect(kept.sources.every((item) => item.error === null)).toBe(true);
      expect(requests).toHaveLength(1);
    } finally {
      await stop();
    }
  });

  it("serves a kept catalog however old it is: age only decides when to read again", async () => {
    const { db, start } = open();
    await start().catalog();
    db.query("UPDATE market_catalog_cache SET fetched_at = 1").run();
    const old = (await start().catalog("cached")).sources[0]!;
    expect(old.entries?.map((entry) => entry.name)).toEqual(["demo"]);
    expect(old.updatedAt).toBe(1);
  });
});
