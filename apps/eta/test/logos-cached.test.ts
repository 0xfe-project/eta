import type { AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
/**
 * `Logos.cached`: what the host kept, answered with no network and outside the lookup queue.
 * Local fake servers only.
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { IconCache } from "../src/plugins/icon-cache";
import { Logos, MAX_CACHED_BYTES, MAX_CACHED_LOGOS } from "../src/plugins/logo";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const REPO = "https://github.com/acme/plugins";
const servers: http.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    server.close();
  }
});

/** A server that takes the request and never answers. */
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

function boot(options: { rawBase?: string } = {}) {
  const db = openDatabase(":memory:");
  applyMigrations(db, loadMigrations());
  const store = new IconCache(db);
  const logos = new Logos({
    allowPrivate: true,
    timeoutMs: 400,
    store,
    ...options,
  });
  return { db, store, logos };
}
const ask = (path: string, homepage: string | null = null) => ({
  repo: REPO,
  ref: "HEAD",
  path,
  homepage,
});
const later = Date.now() + 3_600_000;

describe("logosCached", () => {
  it("answers hit, miss and unknown from the database, and asks no server", async () => {
    const net = await stalled();
    const { store, logos } = boot({ rawBase: net.base });
    store.put(
      REPO,
      "HEAD",
      "p/hit",
      { mime: "image/png", bytes: PNG },
      later,
      Date.now(),
    );
    store.put(REPO, "HEAD", "p/miss", null, later, Date.now());
    const answer = logos.cached([ask("p/hit"), ask("p/miss"), ask("p/never")]);
    expect(answer.map((one) => one.status)).toEqual(["hit", "miss", "unknown"]);
    expect(answer[0]).toMatchObject({ logo: { type: "image/png" } });
    expect(net.hits()).toBe(0);
    expect(logos.requests).toBe(0);
  });

  it("is not held up by lookups that wait on a stalled network", async () => {
    const net = await stalled();
    const { store, logos } = boot({ rawBase: net.base });
    store.put(
      REPO,
      "HEAD",
      "p/hit",
      { mime: "image/png", bytes: PNG },
      later,
      Date.now(),
    );
    // Four lookups fill the queue and hang on the stalled server.
    const waiting = [1, 2, 3, 4, 5].map((n) =>
      logos.fromRepo(REPO, "HEAD", `slow/${n}`),
    );
    await new Promise((done) => setTimeout(done, 50));
    const started = performance.now();
    const answer = logos.cached([ask("p/hit")]);
    expect(performance.now() - started).toBeLessThan(50);
    expect(answer[0]!.status).toBe("hit");
    await Promise.allSettled(waiting);
  });

  it("uses the homepage icon kept under the entry when its own logo is known to be missing", () => {
    const { store, logos } = boot();
    store.put(REPO, "HEAD", "p/x", null, later, Date.now());
    store.put(
      REPO,
      "HEAD",
      "#site:https://x.test/",
      { mime: "image/png", bytes: PNG },
      later,
      Date.now(),
    );
    expect(logos.cached([ask("p/x", "https://x.test/")])[0]!.status).toBe(
      "hit",
    );
    // Own logo missing, homepage not known yet: not known.
    store.put(REPO, "HEAD", "p/y", null, later, Date.now());
    expect(logos.cached([ask("p/y", "https://y.test/")])[0]!.status).toBe(
      "unknown",
    );
  });

  it("looks at no more than MAX_CACHED_LOGOS entries; the rest are unknown, in order", () => {
    const { store, logos } = boot();
    const total = MAX_CACHED_LOGOS + 50;
    for (let n = 0; n < total; n++)
      store.put(
        REPO,
        "HEAD",
        `p/${n}`,
        { mime: "image/png", bytes: PNG },
        later,
        Date.now(),
      );
    const answer = logos.cached(
      Array.from({ length: total }, (_, n) => ask(`p/${n}`)),
    );
    expect(answer).toHaveLength(total);
    expect(
      answer.slice(0, MAX_CACHED_LOGOS).every((one) => one.status === "hit"),
    ).toBe(true);
    expect(
      answer.slice(MAX_CACHED_LOGOS).every((one) => one.status === "unknown"),
    ).toBe(true);
  });

  it("stops handing out pictures once the answer is over MAX_CACHED_BYTES", () => {
    const { store, logos } = boot();
    const big = Buffer.concat([PNG, Buffer.alloc(150 * 1024)]);
    for (let n = 0; n < 40; n++)
      store.put(
        REPO,
        "HEAD",
        `p/${n}`,
        { mime: "image/png", bytes: big },
        later,
        Date.now(),
      );
    const answer = logos.cached(
      Array.from({ length: 40 }, (_, n) => ask(`p/${n}`)),
    );
    const hits = answer.filter((one) => one.status === "hit");
    const sent = hits.reduce(
      (sum, one) => sum + (one.status === "hit" ? one.logo.data.length : 0),
      0,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThan(40);
    expect(sent).toBeLessThanOrEqual(MAX_CACHED_BYTES);
    expect(answer.filter((one) => one.status === "unknown").length).toBe(
      40 - hits.length,
    );
  });

  it("checks stored bytes again: a script in an SVG, or bytes that are not the type, are unknown", () => {
    const { store, logos } = boot();
    const evil = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>',
    );
    store.put(
      REPO,
      "HEAD",
      "p/svg",
      { mime: "image/svg+xml", bytes: evil },
      later,
      Date.now(),
    );
    store.put(
      REPO,
      "HEAD",
      "p/lie",
      { mime: "image/png", bytes: Buffer.from("not a png at all") },
      later,
      Date.now(),
    );
    expect(
      logos.cached([ask("p/svg"), ask("p/lie")]).map((one) => one.status),
    ).toEqual(["unknown", "unknown"]);
  });

  it("does not write: the last-used time of a row is left as it was", () => {
    const { db, store, logos } = boot();
    store.put(
      REPO,
      "HEAD",
      "p/hit",
      { mime: "image/png", bytes: PNG },
      later,
      1000,
    );
    logos.cached([ask("p/hit")]);
    const row = db
      .query("SELECT used_at FROM plugin_icon WHERE path = 'p/hit'")
      .get() as { used_at: number };
    expect(row.used_at).toBe(1000);
  });
});
