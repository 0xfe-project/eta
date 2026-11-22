import type { AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
/**
 * The logo cache in the database, against a local fake of raw.githubusercontent.com that counts its
 * requests. A "restart" is a new `Logos` on the same database.
 */
import http from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { IconCache } from "../src/plugins/icon-cache";
import { Logos, MAX_REPO_LOOKUPS } from "../src/plugins/logo";
import { tempDir } from "./support/host";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';
const REPO = "https://github.com/cursor/plugins.git";
const SHA = "a".repeat(40);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const servers: http.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const manifest = (logo: string) => JSON.stringify({ logo });

/** Every file is served under `/cursor/plugins/<ref>/` for the refs given. */
async function raw(
  files: Record<string, string | Buffer>,
  refs = ["main", SHA],
) {
  const seen: string[] = [];
  const state: { fail: number | null } = { fail: null };
  const server = http.createServer((req, res) => {
    seen.push(String(req.url));
    if (state.fail !== null) return void res.writeHead(state.fail).end();
    for (const ref of refs) {
      const prefix = `/cursor/plugins/${ref}/`;
      if (
        req.url?.startsWith(prefix) &&
        files[req.url.slice(prefix.length)] !== undefined
      )
        return void res.end(files[req.url.slice(prefix.length)]);
    }
    res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    seen,
    state,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

function kept(file?: string) {
  const db = openDatabase(file ?? ":memory:");
  applyMigrations(db, loadMigrations());
  const clock = { at: 1_000_000 };
  const logos = (base: string, cache = new IconCache(db)) =>
    new Logos({
      allowPrivate: true,
      rawBase: base,
      now: () => clock.at,
      timeoutMs: 500,
      store: cache,
    });
  return { db, clock, logos };
}

const FILES = {
  "a/.cursor-plugin/plugin.json": manifest("logo.png"),
  "a/logo.png": PNG,
};

describe("the logo cache in the database", () => {
  it("answers after a restart with no request at all", async () => {
    const { seen, base } = await raw(FILES);
    const { logos } = kept();
    // The same database, a new Logos.
    const db = kept();
    const first = await db.logos(base).fromRepo(REPO, "main", "a");
    expect(first?.type).toBe("image/png");
    const requestsBefore = seen.length;
    expect(requestsBefore).toBe(2);
    const second = await db.logos(base).fromRepo(REPO, "main", "a");
    expect(second).toEqual(first);
    expect(seen).toHaveLength(requestsBefore);
    void logos;
  });

  it("does not keep a failure as no picture, and does not replace a kept one", async () => {
    const { seen, state, base } = await raw(FILES);
    const { db, clock, logos } = kept();
    state.fail = 503;
    expect(await logos(base).fromRepo(REPO, "main", "a")).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM plugin_icon").get()).toEqual({
      n: 0,
    });
    state.fail = null;
    clock.at += 3 * 60 * 1000;
    expect((await logos(base).fromRepo(REPO, "main", "a"))?.type).toBe(
      "image/png",
    );
    // A day later the server fails: the kept picture shows, and the row is not touched.
    clock.at += 2 * DAY;
    const before = db.query("SELECT fetched_at FROM plugin_icon").get();
    state.fail = 500;
    expect((await logos(base).fromRepo(REPO, "main", "a"))?.type).toBe(
      "image/png",
    );
    expect(db.query("SELECT fetched_at FROM plugin_icon").get()).toEqual(
      before,
    );
    void seen;
  });

  it("keeps a HEAD-like ref a day, a commit long, and a confirmed miss an hour", async () => {
    const { seen, base } = await raw({
      ...FILES,
      "none/.cursor-plugin/plugin.json": "{}",
    });
    const { clock, logos } = kept();
    const cold = () => logos(base); // a new Logos: only the database remembers
    await cold().fromRepo(REPO, "main", "a");
    await cold().fromRepo(REPO, SHA, "a");
    await cold().fromRepo(REPO, "main", "none");
    const first = seen.length;
    clock.at += 30 * 60 * 1000;
    await cold().fromRepo(REPO, "main", "a");
    await cold().fromRepo(REPO, "main", "none");
    expect(seen).toHaveLength(first);
    clock.at += HOUR; // past an hour: the miss is asked again, the pictures are not
    await cold().fromRepo(REPO, "main", "none");
    expect(seen.length).toBeGreaterThan(first);
    const second = seen.length;
    clock.at += 2 * DAY; // past a day: main is read again, the commit is not
    await cold().fromRepo(REPO, SHA, "a");
    expect(seen).toHaveLength(second);
    await cold().fromRepo(REPO, "main", "a");
    expect(seen.length).toBeGreaterThan(second);
  });

  it("is keyed by repository, ref and path", async () => {
    const { base } = await raw(FILES);
    const { db, logos } = kept();
    await logos(base).fromRepo(REPO, "main", "a");
    await logos(base).fromRepo(REPO, SHA, "a");
    expect(db.query("SELECT COUNT(*) AS n FROM plugin_icon").get()).toEqual({
      n: 2,
    });
  });

  it("checks a kept row again on read: a script in an SVG, or bytes that are not the type, are dropped", async () => {
    const { seen, base } = await raw(FILES);
    const { db, logos } = kept();
    const put = (mime: string, bytes: Buffer) =>
      db
        .query(
          "INSERT OR REPLACE INTO plugin_icon (repo, ref, path, status, mime, data, fetched_at, expires_at, used_at, size) VALUES (?, 'main', 'a', 'hit', ?, ?, 1, 9999999999999, 1, ?)",
        )
        .run(REPO, mime, bytes, bytes.length);
    put(
      "image/svg+xml",
      Buffer.from(SVG.replace("<rect", "<script>x</script><rect")),
    );
    expect((await logos(base).fromRepo(REPO, "main", "a"))?.type).toBe(
      "image/png",
    );
    expect(seen.length).toBeGreaterThan(0);
    put("image/png", Buffer.from("not a png"));
    expect((await logos(base).fromRepo(REPO, "main", "a"))?.type).toBe(
      "image/png",
    );
    put("text/html", Buffer.from("<b>x</b>"));
    expect((await logos(base).fromRepo(REPO, "main", "a"))?.type).toBe(
      "image/png",
    );
  });

  it("drops the least recently used rows over the cap, and can be cleared", async () => {
    const { db } = kept();
    const cache = new IconCache(db, { maxRows: 2 });
    const pic = { mime: "image/png", bytes: PNG };
    cache.put(REPO, "main", "a", pic, 9e12, 1);
    cache.put(REPO, "main", "b", pic, 9e12, 2);
    cache.get(REPO, "main", "a", 3);
    cache.put(REPO, "main", "c", pic, 9e12, 4);
    expect(cache.get(REPO, "main", "a", 5)).toBeDefined();
    expect(cache.get(REPO, "main", "b", 5)).toBeUndefined();
    const small = new IconCache(db, {
      maxTotalBytes: PNG.length + 1,
      maxRows: 99,
    });
    small.put(REPO, "main", "d", pic, 9e12, 6);
    expect(small.get(REPO, "main", "d", 7)).toBeDefined();
    expect(cache.clear()).toBeGreaterThan(0);
    expect(db.query("SELECT COUNT(*) AS n FROM plugin_icon").get()).toEqual({
      n: 0,
    });
  });

  it("writes from four lookups at once into a database file", async () => {
    const files: Record<string, string | Buffer> = {};
    for (let i = 0; i < 12; i++) {
      files[`p${i}/.cursor-plugin/plugin.json`] = manifest("l.svg");
      files[`p${i}/l.svg`] = SVG;
    }
    const { base } = await raw(files);
    const dir = await tempDir("eta-icons-");
    const { db, logos } = kept(join(dir, "host.db"));
    const one = logos(base);
    const all = await Promise.all(
      Array.from({ length: 12 }, (_, i) => one.fromRepo(REPO, "main", `p${i}`)),
    );
    expect(all.every((logo) => logo?.type === "image/svg+xml")).toBe(true);
    expect(one.peak).toBeLessThanOrEqual(MAX_REPO_LOOKUPS);
    expect(db.query("SELECT COUNT(*) AS n FROM plugin_icon").get()).toEqual({
      n: 12,
    });
    // Read back from a second connection to the same file.
    const again = openDatabase(join(dir, "host.db"));
    expect(again.query("SELECT COUNT(*) AS n FROM plugin_icon").get()).toEqual({
      n: 12,
    });
    // An open file cannot be removed on Windows.
    again.close();
    db.close();
  });
});
