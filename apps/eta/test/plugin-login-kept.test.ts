/**
 * What a check or a test found out about a server's sign-in is kept in the host's database, so the
 * card still says "needs login" after the host restarts, and says nothing wrong once it stops being
 * true: a login, a good answer, a changed address, an uninstall or a reinstall all clear it. A
 * restart is a new Plugins and pluginsPlugin over the same database and plugin directory. Local
 * fake servers only.
 */
import type { AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { pluginsPlugin } from "../src/plugins/plugin";
import { Plugins } from "../src/plugins/service";
import { SettingStore } from "../src/settings/store";

const PLUGIN = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const CHALLENGE =
  'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/mcp", error="invalid_token"';

const dirs: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    server.close();
  }
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

/** A streamable-HTTP MCP server that wants a sign-in (401 with a challenge) or lets everyone in; the mode can change. */
async function fake(first: "login" | "open") {
  let hits = 0;
  const state = { mode: first };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      hits++;
      if (state.mode === "login")
        return void res
          .writeHead(401, { "www-authenticate": CHALLENGE })
          .end("sign in with the token please");
      if (req.method !== "POST") return void res.writeHead(405).end();
      let rpc: {
        id?: number;
        method?: string;
        params?: { protocolVersion?: string };
      } = {};
      try {
        rpc = JSON.parse(body);
      } catch {
        // No body.
      }
      const reply = (result: unknown) =>
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      if (rpc.method === "initialize")
        return reply({
          protocolVersion: rpc.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1" },
        });
      if (rpc.method === "tools/list") return reply({ tools: [] });
      res.writeHead(202).end();
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    state,
    get hits() {
      return hits;
    },
  };
}

async function writePlugin(dataDir: string, url: string) {
  const dir = join(dataDir, "plugins", "demo");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "plugin.json"),
    JSON.stringify({ $schema: PLUGIN, name: "demo" }),
  );
  await writeFile(
    join(dir, "mcp.json"),
    JSON.stringify({
      $schema: MCP,
      mcpServers: { remote: { type: "streamable-http", url } },
    }),
  );
}

async function world(url: string) {
  const dataDir = await mkdtemp(join(tmpdir(), "eta-login-kept-"));
  dirs.push(dataDir);
  await writePlugin(dataDir, url);
  const db = openDatabase(":memory:");
  applyMigrations(db, loadMigrations());
  db.exec("PRAGMA foreign_keys = OFF");
  // The credentials are the MCP service's own, not this feature's: a sign-in is a flag here.
  const credentials = { signed: false };
  const mcp = {
    storedAuthProvider: () => undefined,
    signInStamp: () => (credentials.signed ? "stamp" : undefined),
    signedIn: () => credentials.signed,
    loginUrl: async () => {
      credentials.signed = true;
      return { status: "signed_in" };
    },
    logoutUrl: async () => {
      credentials.signed = false;
    },
    releaseUrls: async () => {},
    keyOf: (url: string) => url,
  };
  /** The host starting: everything new, the database and the files the same. */
  const start = async () => {
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
    let project: () => { sections: Record<string, unknown> } = () => ({
      sections: {},
    });
    const wire = {
      handle: (target: string, action: string, run: never) => {
        handlers.set(`${target}.${action}`, run);
        return () => {};
      },
      stateOf: (_target: string, options: { project: typeof project }) => {
        project = options.project;
        return () => {};
      },
      pushNow: () => {},
    };
    const deps = {
      plugins,
      agents: {},
      market: { install: async () => "demo" },
      mcp,
      settings: new SettingStore(db),
    };
    pluginsPlugin(deps as never, () => {}).apply({
      wire,
      sessions: {},
      effect: (run: () => unknown) => run(),
    } as never);
    return {
      plugins,
      call: (action: string, args: Record<string, unknown>) =>
        handlers.get(`plugins.${action}`)!({ target: "plugins", action, args }),
      login: () =>
        (
          project().sections.list as {
            name: string;
            servers: { name: string; login?: string }[];
          }[]
        )
          .find((view) => view.name === "demo")!
          .servers.find((server) => server.name === "remote")?.login,
    };
  };
  const kept = () =>
    db
      .query<{ key: string; value: string }, []>(
        "SELECT key, value FROM setting WHERE key LIKE 'plugins.login.%'",
      )
      .all();
  return { dataDir, credentials, start, kept };
}

const install = (host: {
  call: (a: string, b: Record<string, unknown>) => unknown;
}) =>
  host.call("marketInstall", {
    name: "demo",
    source: "s",
    sha: "a".repeat(40),
  });
const settle = () => new Promise((done) => setTimeout(done, 400));

/** A host that has installed the plugin and learned that its server wants a sign-in. */
async function learned() {
  const site = await fake("login");
  const w = await world(site.url);
  const first = await w.start();
  await install(first);
  await vi.waitFor(() => expect(first.login()).toBe("needs_login"));
  return { site, ...w };
}

describe("the 'needs login' a check found, after the host restarts", () => {
  it("is still shown, and no request is made to find it again", async () => {
    const { site, start } = await learned();
    const before = site.hits;
    const restarted = await start();
    expect(restarted.login()).toBe("needs_login");
    await settle();
    expect(site.hits).toBe(before);
  });

  it("keeps no token and none of the server's answer", async () => {
    const { kept } = await learned();
    const rows = kept();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows)
      for (const secret of ["invalid_token", "Bearer", "sign in with", "stamp"])
        expect(row.value).not.toContain(secret);
  });

  it("gives way to a stored sign-in, and is cleared by a sign-in so it does not come back after a sign-out", async () => {
    const { credentials, start } = await learned();
    credentials.signed = true; // signed in elsewhere: the kept answer gives way
    expect((await start()).login()).toBe("signed_in");
    credentials.signed = false;
    const second = await start();
    await second.call("loginServer", { name: "demo", server: "remote" });
    expect(credentials.signed).toBe(true);
    const third = await start();
    expect(third.login()).toBe("signed_in");
    credentials.signed = false; // signed out somewhere else
    const fourth = await start();
    expect(fourth.login()).not.toBe("needs_login");
  });
  it("is replaced by a later good answer", async () => {
    const { site, start } = await learned();
    site.state.mode = "open";
    const second = await start();
    await second.call("testServer", { name: "demo", server: "remote" });
    expect((await start()).login()).not.toBe("needs_login");
  });

  it("is void once the server's address changes", async () => {
    const { site, dataDir, start } = await learned();
    await writePlugin(dataDir, `${site.url}/v2`);
    expect((await start()).login()).not.toBe("needs_login");
  });

  it("is cleared when the plugin is removed", async () => {
    const { start, kept } = await learned();
    const second = await start();
    vi.spyOn(second.plugins.registry, "remove").mockResolvedValue(undefined);
    await second.call("remove", { name: "demo" });
    expect(kept()).toHaveLength(0);
  });

  it("is cleared by a new install, even when nothing is checked", async () => {
    const { start } = await learned();
    const second = await start();
    second.plugins.setEnabled("demo", false); // a disabled plugin is not checked
    await install(second);
    expect((await start()).login()).not.toBe("needs_login");
  });
});
