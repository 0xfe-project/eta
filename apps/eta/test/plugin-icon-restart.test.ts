import type { AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
/**
 * A restart against a database file on disk: a catalog entry with no logo of its own and a homepage
 * with an icon is asked once; after a new Logos on a re-opened file no site is asked again.
 * Local fake servers only.
 */
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { IconCache } from "../src/plugins/icon-cache";
import { Logos } from "../src/plugins/logo";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
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

describe("a restart keeps the homepage fallback of an entry too", () => {
  it("asks the homepage once, then nothing, through a database file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eta-icon-restart-"));
    dirs.push(dir);
    const file = join(dir, "eta.sqlite");
    const site: string[] = [];
    const raw: string[] = [];
    const rawBase = await listen((req, res) => {
      raw.push(String(req.url));
      res.writeHead(404).end();
    });
    const home = await listen((req, res) => {
      site.push(String(req.url));
      if (req.url === "/") res.end('<link rel="icon" href="/i.png"/>');
      else if (req.url === "/i.png") res.end(PNG);
      else res.writeHead(404).end();
    });
    const repo = "https://github.com/acme/plugins.git";
    const boot = () => {
      const db = openDatabase(file);
      applyMigrations(db, loadMigrations());
      return {
        db,
        logos: new Logos({
          allowPrivate: true,
          rawBase,
          timeoutMs: 500,
          store: new IconCache(db),
        }),
      };
    };

    const first = boot();
    const a = await first.logos.forEntry(repo, "HEAD", "plugins/x", `${home}/`);
    expect(a?.type).toBe("image/png");
    expect(site.length).toBeGreaterThan(0);
    first.db.close();

    const sitesBefore = site.length;
    const rawBefore = raw.length;
    const second = boot();
    const b = await second.logos.forEntry(
      repo,
      "HEAD",
      "plugins/x",
      `${home}/`,
    );
    expect(b?.type).toBe("image/png");
    expect(site.length).toBe(sitesBefore);
    expect(raw.length).toBe(rawBefore);
    second.db.close();
  });

  it("keeps a homepage that has no icon as a miss too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eta-icon-restart-"));
    dirs.push(dir);
    const file = join(dir, "eta.sqlite");
    const rawBase = await listen((_req, res) => void res.writeHead(404).end());
    const seen: string[] = [];
    const home = await listen((req, res) => {
      seen.push(String(req.url));
      res.writeHead(404).end();
    });
    const run = async () => {
      const db = openDatabase(file);
      applyMigrations(db, loadMigrations());
      const logos = new Logos({
        allowPrivate: true,
        rawBase,
        timeoutMs: 500,
        store: new IconCache(db),
      });
      const out = await logos.forEntry(
        "https://github.com/acme/plugins.git",
        "HEAD",
        "p",
        `${home}/`,
      );
      db.close();
      return out;
    };
    expect(await run()).toBeNull();
    const n = seen.length;
    expect(n).toBeGreaterThan(0);
    expect(await run()).toBeNull();
    expect(seen.length).toBe(n);
  });
  it("does not keep a homepage that could not be asked as a miss", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eta-icon-restart-"));
    dirs.push(dir);
    const file = join(dir, "eta.sqlite");
    const rawBase = await listen((_req, res) => void res.writeHead(404).end());
    let broken = true;
    const home = await listen((req, res) => {
      if (broken) return void res.writeHead(503).end();
      if (req.url === "/") res.end('<link rel="icon" href="/i.png"/>');
      else if (req.url === "/i.png") res.end(PNG);
      else res.writeHead(404).end();
    });
    const clock = { at: 5_000_000 };
    const db = openDatabase(file);
    applyMigrations(db, loadMigrations());
    const logos = new Logos({
      allowPrivate: true,
      rawBase,
      timeoutMs: 500,
      now: () => clock.at,
      store: new IconCache(db),
    });
    const repo = "https://github.com/acme/plugins.git";
    expect(await logos.forEntry(repo, "HEAD", "p", `${home}/`)).toBeNull();
    const rows = db
      .query("select count(*) n from plugin_icon where path like '#site:%'")
      .get() as { n: number };
    expect(rows.n).toBe(0);
    broken = false;
    clock.at += 3 * 60 * 1000;
    expect((await logos.forEntry(repo, "HEAD", "p", `${home}/`))?.type).toBe(
      "image/png",
    );
    db.close();
  });
});
