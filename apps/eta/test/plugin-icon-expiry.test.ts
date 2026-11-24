/**
 * What is kept about an entry's picture, and when it stops counting. An entry with no logo of its own
 * and a homepage icon keeps two rows: "no own logo" (short, unless the ref is a commit, whose
 * content cannot change) and the homepage picture (long). A lookup that only reads (`cached`) must
 * not let the short row hide the long one. A database file on disk, a clock we move, local servers.
 */
import type { AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { IconCache } from "../src/plugins/icon-cache";
import { Logos } from "../src/plugins/logo";

const MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SITE_PNG = Buffer.from([...MAGIC, 1, 1, 1]);
const OWN_PNG = Buffer.from([...MAGIC, 2, 2, 2]);
const REPO = "https://github.com/acme/plugins.git";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const servers: http.Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    server.close();
  }
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function world(options: { own?: boolean; rawStatus?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "eta-icon-expiry-"));
  dirs.push(dir);
  const file = join(dir, "eta.sqlite");
  const counts = { raw: 0, site: 0 };
  const state = {
    own: options.own === true,
    rawStatus: options.rawStatus ?? 0,
  };
  const rawBase = await listen((req, res) => {
    counts.raw++;
    if (state.rawStatus !== 0) return void res.writeHead(state.rawStatus).end();
    const url = String(req.url);
    if (state.own && url.endsWith(".cursor-plugin/plugin.json"))
      return void res.end('{"logo":"assets/l.png"}');
    if (state.own && url.endsWith("assets/l.png")) return void res.end(OWN_PNG);
    res.writeHead(404).end();
  });
  const home = await listen((req, res) => {
    counts.site++;
    if (req.url === "/") res.end('<link rel="icon" href="/i.png"/>');
    else if (req.url === "/i.png") res.end(SITE_PNG);
    else res.writeHead(404).end();
  });
  const clock = { at: 10_000_000_000 };
  const boot = () => {
    const db = openDatabase(file);
    applyMigrations(db, loadMigrations());
    const store = new IconCache(db);
    const logos = new Logos({
      allowPrivate: true,
      rawBase,
      timeoutMs: 500,
      store,
      now: () => clock.at,
    });
    return { db, store, logos };
  };
  const ask = (ref: string, homepage: string | null = `${home}/`) => ({
    repo: REPO,
    ref,
    path: "plugins/x",
    homepage,
  });
  return { boot, clock, counts, state, ask };
}

const bytesOf = (answer: { status: string; logo?: { data: string } }) =>
  answer.status === "hit"
    ? Buffer.from(answer.logo!.data, "base64").toString("hex")
    : answer.status;

describe("a picture kept under the homepage still counts when the short 'no own logo' row is old", () => {
  it("a new Logos on the same file (a restart), inside the hour: a hit, and no request", async () => {
    const w = await world();
    const first = w.boot();
    await first.logos.forEntry(
      REPO,
      "HEAD",
      "plugins/x",
      w.ask("HEAD").homepage,
    );
    first.db.close();
    const before = { ...w.counts };
    w.clock.at += 30 * MINUTE;
    const second = w.boot();
    expect(second.logos.cached([w.ask("HEAD")])[0]!.status).toBe("hit");
    expect(w.counts).toEqual(before);
    second.db.close();
  });

  it("61 minutes on, once the short row has expired: still a hit (this is what failed)", async () => {
    const w = await world();
    const first = w.boot();
    await first.logos.forEntry(
      REPO,
      "HEAD",
      "plugins/x",
      w.ask("HEAD").homepage,
    );
    first.db.close();
    const before = { ...w.counts };
    w.clock.at += 61 * MINUTE;
    const second = w.boot();
    // The own row is a miss that expired: `peek` says "not known", the homepage row is a day long.
    expect(second.store.peek(REPO, "HEAD", "plugins/x")?.status).toBe("miss");
    expect(w.clock.at).toBeGreaterThan(
      second.store.peek(REPO, "HEAD", "plugins/x")!.expiresAt,
    );
    expect(second.logos.cached([w.ask("HEAD")])[0]!.status).toBe("hit");
    expect(w.counts).toEqual(before);
    second.db.close();
  });

  it("past the homepage row's own day the picture still shows (a stale hit is better than a letter), and the read asks nothing", async () => {
    const w = await world();
    const first = w.boot();
    await first.logos.forEntry(
      REPO,
      "HEAD",
      "plugins/x",
      w.ask("HEAD").homepage,
    );
    first.db.close();
    const before = { ...w.counts };
    w.clock.at += DAY + MINUTE;
    const second = w.boot();
    expect(second.logos.cached([w.ask("HEAD")])[0]!.status).toBe("hit");
    expect(w.counts).toEqual(before);
    second.db.close();
  });

  it("an own logo that is known still wins over the homepage's", async () => {
    const w = await world({ own: true });
    const first = w.boot();
    const found = await first.logos.forEntry(
      REPO,
      "HEAD",
      "plugins/x",
      w.ask("HEAD").homepage,
    );
    expect(Buffer.from(found!.data, "base64").toString("hex")).toBe(
      OWN_PNG.toString("hex"),
    );
    // A homepage picture kept as well (as an earlier run without the own logo would have left).
    first.store.put(
      REPO,
      "HEAD",
      `#site:${w.ask("HEAD").homepage}`,
      { mime: "image/png", bytes: SITE_PNG },
      w.clock.at + DAY,
      w.clock.at,
    );
    expect(bytesOf(first.logos.cached([w.ask("HEAD")])[0] as never)).toBe(
      OWN_PNG.toString("hex"),
    );
    first.db.close();
  });

  it("an own logo not known yet is not hidden by an unrelated unknown: a homepage hit shows, a homepage miss does not say 'none'", async () => {
    const w = await world();
    const { db, logos, store } = w.boot();
    const homepage = w.ask("HEAD").homepage!;
    // Nothing about the own logo is kept; the homepage row is a hit.
    store.put(
      REPO,
      "HEAD",
      `#site:${homepage}`,
      { mime: "image/png", bytes: SITE_PNG },
      w.clock.at + DAY,
      w.clock.at,
    );
    expect(logos.cached([w.ask("HEAD")])[0]!.status).toBe("hit");
    // A homepage miss, and the own logo still not known: it stays unknown, not 'none'.
    store.put(
      REPO,
      "HEAD",
      `#site:${homepage}`,
      null,
      w.clock.at + HOUR,
      w.clock.at,
    );
    expect(logos.cached([w.ask("HEAD")])[0]!.status).toBe("unknown");
    db.close();
  });
});

describe("how long 'no own logo' is kept", () => {
  it("at a branch or HEAD: an hour, then the next ask goes to the network again", async () => {
    const w = await world();
    const { db, logos, store } = w.boot();
    expect(await logos.forEntry(REPO, "HEAD", "plugins/x", null)).toBeNull();
    const row = store.peek(REPO, "HEAD", "plugins/x")!;
    expect(row.status).toBe("miss");
    expect(row.expiresAt - w.clock.at).toBe(HOUR);
    const asked = w.counts.raw;
    w.clock.at += 59 * MINUTE;
    expect(logos.cached([w.ask("HEAD", null)])[0]!.status).toBe("miss");
    w.clock.at += 2 * MINUTE;
    expect(logos.cached([w.ask("HEAD", null)])[0]!.status).toBe("unknown");
    await logos.forEntry(REPO, "HEAD", "plugins/x", null);
    expect(w.counts.raw).toBeGreaterThan(asked);
    db.close();
  });

  it("at a commit: as long as a picture (the content cannot change), and nothing is asked again after an hour", async () => {
    const w = await world();
    const first = w.boot();
    expect(
      await first.logos.forEntry(REPO, COMMIT, "plugins/x", null),
    ).toBeNull();
    const row = first.store.peek(REPO, COMMIT, "plugins/x")!;
    expect(row.status).toBe("miss");
    expect(row.expiresAt - w.clock.at).toBe(30 * DAY);
    first.db.close();
    const asked = w.counts.raw;
    w.clock.at += 2 * HOUR;
    const second = w.boot();
    expect(second.logos.cached([w.ask(COMMIT, null)])[0]!.status).toBe("miss");
    expect(
      await second.logos.forEntry(REPO, COMMIT, "plugins/x", null),
    ).toBeNull();
    expect(w.counts.raw).toBe(asked);
    second.db.close();
  });

  it("the homepage row's length is not changed by this: a homepage that has no icon is still an hour", async () => {
    const w = await world();
    const { db, logos, store } = w.boot();
    const home = `http://127.0.0.1:1/`; // nothing there: a refused connection is a failure, not a miss
    void home;
    const noIcon = await listen((_req, res) => void res.writeHead(404).end());
    await logos.forEntry(REPO, COMMIT, "plugins/x", `${noIcon}/`);
    const row = store.peek(REPO, COMMIT, `#site:${noIcon}/`)!;
    expect(row.status).toBe("miss");
    expect(row.expiresAt - w.clock.at).toBe(HOUR);
    db.close();
  });

  it("a failed ask (the server is down) is not kept as 'no own logo', at a commit either", async () => {
    const w = await world({ rawStatus: 503 });
    const { db, logos, store } = w.boot();
    expect(await logos.forEntry(REPO, COMMIT, "plugins/x", null)).toBeNull();
    expect(store.peek(REPO, COMMIT, "plugins/x")).toBeUndefined();
    expect(logos.cached([w.ask(COMMIT, null)])[0]!.status).toBe("unknown");
    db.close();
  });
});
