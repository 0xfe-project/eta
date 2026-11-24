/**
 * After a plugin is added or installed, the host asks each of its remote servers once whether it
 * wants a sign-in, so the card says so without the user pressing Test. It never starts a stdio
 * server, skips a plugin that is off or needs setup, and never holds the install back.
 */
import type { AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { pluginsPlugin } from "../src/plugins/plugin";
import { Plugins } from "../src/plugins/service";

const PLUGIN = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

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

/** A streamable-HTTP MCP server that either wants an OAuth sign-in (401 with a challenge) or lets everyone in. */
async function fake(mode: "login" | "open") {
  let hits = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      hits++;
      if (mode === "login")
        return void res
          .writeHead(401, {
            "www-authenticate":
              'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/mcp", error="invalid_token"',
          })
          .end("no");
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
    get hits() {
      return hits;
    },
  };
}

async function setup(url: string, options: { needsSetup?: boolean } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "eta-auto-check-"));
  dirs.push(dataDir);
  const marker = join(dataDir, "stdio-was-started");
  const script = join(dataDir, "start.cjs");
  await writeFile(
    script,
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");`,
  );
  const dir = join(dataDir, "plugins", "demo");
  await mkdir(join(dir, ".claude-plugin"), { recursive: true });
  if (options.needsSetup) {
    // A Claude-format plugin whose header names a variable nobody has set: it needs setup.
    await writeFile(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "demo" }),
    );
    await writeFile(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          remote: {
            type: "http",
            url,
            headers: {
              // eslint-disable-next-line no-template-curly-in-string -- a plugin variable, not a template
              "X-Api-Key": "${API_KEY}",
            },
          },
        },
      }),
    );
  } else {
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ $schema: PLUGIN, name: "demo" }),
    );
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({
        $schema: MCP,
        mcpServers: {
          remote: { type: "streamable-http", url },
          // A command is one bare name; the script that leaves the marker is its argument.
          local: { type: "stdio", command: "node", args: [script] },
        },
      }),
    );
  }
  const db = openDatabase(":memory:");
  applyMigrations(db, loadMigrations());
  db.exec("PRAGMA foreign_keys = OFF");
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
  const pushed: string[] = [];
  const wire = {
    handle: (target: string, action: string, run: never) => {
      handlers.set(`${target}.${action}`, run);
      return () => {};
    },
    stateOf: (_target: string, options: { project: typeof project }) => {
      project = options.project;
      return () => {};
    },
    pushNow: (target: string) => void pushed.push(target),
  };
  // No stored sign-in anywhere: a server's 401 challenge is all there is to read.
  const mcp = {
    storedAuthProvider: () => undefined,
    signInStamp: () => undefined,
    signedIn: () => false,
  };
  pluginsPlugin(
    {
      plugins,
      agents: {} as never,
      market: { install: async () => "demo" } as never,
      mcp: mcp as never,
    },
    () => {},
  ).apply({
    wire,
    sessions: {},
    effect: (run: () => unknown) => run(),
  } as never);
  const call = (action: string, args: Record<string, unknown>) =>
    handlers.get(`plugins.${action}`)!({ target: "plugins", action, args });
  const logins = () =>
    (
      project().sections.list as {
        name: string;
        servers: { name: string; login?: string }[];
      }[]
    )
      .find((view) => view.name === "demo")!
      .servers.map((server) => [server.name, server.login]);
  const install = () =>
    call("marketInstall", { name: "demo", source: "s", sha: "a".repeat(40) });
  return { plugins, call, install, logins, pushed, marker };
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
const settle = () => new Promise((done) => setTimeout(done, 400));

describe("the login check after an install", () => {
  it("marks a remote server that answers 401 with a sign-in challenge as needing login, and tells the client", async () => {
    const server = await fake("login");
    const { install, logins, pushed } = await setup(server.url);
    await expect(install()).resolves.toEqual({ result: { name: "demo" } });
    await vi.waitFor(() =>
      expect(logins()).toContainEqual(["remote", "needs_login"]),
    );
    expect(pushed).toContain("plugins");
    expect(server.hits).toBeGreaterThan(0);
  });

  it("leaves a server that lets everyone in unmarked", async () => {
    const server = await fake("open");
    const { install, logins } = await setup(server.url);
    await install();
    await vi.waitFor(() => expect(server.hits).toBeGreaterThan(0));
    await settle();
    expect(logins()).toContainEqual(["remote", "none"]);
  });

  it("never starts a stdio server", async () => {
    const server = await fake("login");
    const { install, logins, marker, call } = await setup(server.url);
    await install();
    await vi.waitFor(() =>
      expect(logins()).toContainEqual(["remote", "needs_login"]),
    );
    await settle();
    expect(await exists(marker)).toBe(false);
    // The control: a test the user presses on that server does start it, so the fixture is real.
    await call("testServer", { name: "demo", server: "local" });
    expect(await exists(marker)).toBe(true);
  });

  it("does the same for a plugin added by hand", async () => {
    const server = await fake("login");
    const { plugins, call, logins } = await setup(server.url);
    vi.spyOn(plugins.registry, "add").mockResolvedValue("demo");
    await call("add", { repo: "https://github.com/a/b" });
    await vi.waitFor(() =>
      expect(logins()).toContainEqual(["remote", "needs_login"]),
    );
  });

  it("is silent and sends nothing for a plugin that is off", async () => {
    const server = await fake("login");
    const { plugins, install, logins } = await setup(server.url);
    plugins.setEnabled("demo", false);
    await expect(install()).resolves.toEqual({ result: { name: "demo" } });
    await settle();
    expect(server.hits).toBe(0);
    expect(logins()).toContainEqual(["remote", "none"]);
  });

  it("is silent and sends nothing for a plugin that needs setup", async () => {
    const server = await fake("login");
    const { plugins, install, logins } = await setup(server.url, {
      needsSetup: true,
    });
    // The fixture really is a plugin that needs setup.
    expect(plugins.view().find((one) => one.name === "demo")?.state).toBe(
      "needs_config",
    );
    await expect(install()).resolves.toEqual({ result: { name: "demo" } });
    await settle();
    expect(server.hits).toBe(0);
    expect(logins()).toContainEqual(["remote", "none"]);
  });
});
