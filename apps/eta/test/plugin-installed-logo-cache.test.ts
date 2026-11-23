/**
 * An installed plugin's icon (its homepage's, or its remote server's site's) is kept in the host's
 * database, so the first load after a restart reads it from there and asks no site. Local fake
 * sites only; a restart is a new Logos on the same database.
 */
import type { AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { IconCache } from "../src/plugins/icon-cache";
import { Logos } from "../src/plugins/logo";
import { pluginsPlugin } from "../src/plugins/plugin";
import { Plugins } from "../src/plugins/service";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const ICO = Buffer.from([
  0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 4, 0, 0, 0, 22, 0, 0, 0, 1, 2, 3,
  4,
]);
const OWN = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9,
]);
const HOUR = 60 * 60 * 1000;

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

/** A site with an icon (or none, or a server error), counting what it was asked. */
async function site(mode: { icon: boolean; broken?: boolean; ico?: boolean }) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (mode.broken) return void res.writeHead(500).end();
    if (mode.icon && req.url === "/")
      return void res.end(
        `<link rel="icon" href="/i.${mode.ico ? "ico" : "png"}"/>`,
      );
    if (mode.icon && req.url === "/i.png") return void res.end(PNG);
    if (mode.icon && req.url === "/i.ico") return void res.end(ICO);
    res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    mode,
    get hits() {
      return hits;
    },
  };
}

function database() {
  const db = openDatabase(":memory:");
  applyMigrations(db, loadMigrations());
  return db;
}
/** Starting the host again: a new Logos over the same database. */
const boot = (db: ReturnType<typeof database>, now?: () => number) =>
  new Logos({
    allowPrivate: true,
    timeoutMs: 500,
    store: new IconCache(db),
    ...(now === undefined ? {} : { now }),
  });

/** What `find` is asked: the plugin's own logo, its homepage, its remote server's address. */
type Ask = [string | null, string | null, string | null];

describe("an installed plugin's icon after a restart", () => {
  it.each([
    {
      name: "a homepage",
      mode: { icon: true },
      type: "image/png",
      ask: (url: string): Ask => [null, `${url}/`, null],
    },
    {
      name: "a remote server's site",
      mode: { icon: true },
      type: "image/png",
      ask: (url: string): Ask => [null, null, `${url}/mcp`],
    },
    {
      name: "a homepage with an ico",
      mode: { icon: true, ico: true },
      type: "image/x-icon",
      ask: (url: string): Ask => [null, `${url}/`, null],
    },
  ])(
    "is read from the database for $name, and no site is asked",
    async ({ mode, type, ask }) => {
      const site_ = await site(mode);
      const db = database();
      const first = await boot(db).find(...ask(site_.url));
      expect(first?.type).toBe(type);
      const before = site_.hits;
      expect(before).toBeGreaterThan(0);

      const restarted = boot(db);
      expect(await restarted.find(...ask(site_.url))).toEqual(first);
      expect(restarted.requests).toBe(0);
      expect(site_.hits).toBe(before);
    },
  );

  it("keeps 'no icon' for a while, then asks again", async () => {
    const home = await site({ icon: false });
    const db = database();
    const start = 1_000_000_000_000;
    expect(await boot(db, () => start).find(null, `${home.url}/`, null)).toBe(
      null,
    );
    const before = home.hits;
    expect(before).toBeGreaterThan(0);

    const soon = boot(db, () => start + 10 * 60 * 1000);
    expect(await soon.find(null, `${home.url}/`, null)).toBe(null);
    expect(soon.requests).toBe(0);
    expect(home.hits).toBe(before);

    const later = boot(db, () => start + 2 * HOUR);
    expect(await later.find(null, `${home.url}/`, null)).toBe(null);
    expect(home.hits).toBeGreaterThan(before);
  });

  it("asks again once a kept icon is a day old", async () => {
    const home = await site({ icon: true });
    const db = database();
    const start = 1_000_000_000_000;
    await boot(db, () => start).find(null, `${home.url}/`, null);
    const before = home.hits;
    const later = boot(db, () => start + 25 * HOUR);
    expect((await later.find(null, `${home.url}/`, null))?.type).toBe(
      "image/png",
    );
    expect(home.hits).toBeGreaterThan(before);
  });

  it("does not keep a failed ask as 'no icon'", async () => {
    const home = await site({ icon: true, broken: true });
    const db = database();
    expect(await boot(db).find(null, `${home.url}/`, null)).toBe(null);
    home.mode.broken = false;
    const restarted = boot(db);
    expect((await restarted.find(null, `${home.url}/`, null))?.type).toBe(
      "image/png",
    );
    expect(restarted.requests).toBeGreaterThan(0);
  });
});

describe("the plugin's own logo file", () => {
  it("still comes first, over a kept homepage icon", async () => {
    const home = await site({ icon: true });
    const dataDir = await mkdtemp(join(tmpdir(), "eta-installed-logo-"));
    dirs.push(dataDir);
    const dir = join(dataDir, "plugins", "demo");
    await mkdir(join(dir, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "demo",
        logo: "logo.png",
        homepage: `${home.url}/`,
      }),
    );
    await writeFile(join(dir, "logo.png"), OWN);

    const db = database();
    db.exec("PRAGMA foreign_keys = OFF");
    // The homepage's icon is already kept, as after an earlier run without the file.
    await boot(db).find(null, `${home.url}/`, null);
    const before = home.hits;

    const plugins = new Plugins({
      db,
      dataDir,
      key: Buffer.alloc(32, 1),
      agents: { get: () => ({ runtime: "eta" }) } as never,
      machines: { list: () => [] } as never,
      hub: { onReady: () => {} } as never,
      changed: () => {},
      warn: () => {},
    });
    await plugins.registry.refresh();
    const handlers = new Map<string, (call: unknown) => unknown>();
    const wire = {
      handle: (target: string, action: string, run: never) => {
        handlers.set(`${target}.${action}`, run);
        return () => {};
      },
      stateOf: () => () => {},
      pushNow: () => {},
    };
    pluginsPlugin(
      {
        plugins,
        agents: {} as never,
        market: {} as never,
        icons: new IconCache(db),
      },
      () => {},
    ).apply({
      wire,
      sessions: {},
      effect: (run: () => unknown) => run(),
    } as never);
    const got = (await handlers.get("plugins.logo")!({
      target: "plugins",
      action: "logo",
      args: { plugin: "demo" },
    })) as { result: { type: string; data: string } };
    expect(got.result).toEqual({
      type: "image/png",
      data: OWN.toString("base64"),
    });
    expect(home.hits).toBe(before);
  });
});
