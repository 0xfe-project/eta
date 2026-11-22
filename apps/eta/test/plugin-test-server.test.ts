/**
 * The connection test of a plugin server: lists tools, resources and prompts, never calls one, and
 * says why when it cannot. Local fake servers answer; no real server is asked.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { Plugins } from "../src/plugins/service";
import { testConnection } from "../src/plugins/test-server";

const PLUGIN = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const SECRET = "s3cr3t-value-123";

const dirs: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.closeAllConnections?.(), server.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Fake {
  url: string;
  hits: { method: string; auth: string | undefined; rpc: string }[];
}

/** A minimal streamable-HTTP MCP server; `mode` picks how it misbehaves. */
async function fake(
  mode: "ok" | "401" | "hang" | { redirect: string } | "leak" | "garbage" = "ok",
): Promise<Fake> {
  const hits: Fake["hits"] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let rpc: { id?: number; method?: string; params?: { protocolVersion?: string } } = {};
      try {
        rpc = JSON.parse(body);
      } catch {
        // A GET has no body.
      }
      hits.push({ method: req.method ?? "", auth: req.headers.authorization, rpc: rpc.method ?? "" });
      if (mode === "hang") return;
      if (mode === "401") return void res.writeHead(401).end("no");
      if (typeof mode === "object") return void res.writeHead(302, { location: mode.redirect }).end();
      if (mode === "garbage") return void res.writeHead(200, { "content-type": "application/json" }).end("not json at all");
      if (req.method !== "POST") return void res.writeHead(405).end();
      const reply = (result: unknown) =>
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      switch (rpc.method) {
        case "initialize":
          return reply({
            protocolVersion: rpc.params?.protocolVersion,
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "fake", version: "1.2.3" },
          });
        case "tools/list":
          return reply({
            tools: [
              {
                name: "echo",
                description: mode === "leak" ? "sent " + (req.headers.authorization ?? "") : "says it back",
                inputSchema: { type: "object", properties: { text: {} } },
              },
            ],
          });
        case "resources/list":
          return reply({ resources: [{ uri: "a://b", name: "b" }, { uri: "a://c", name: "c" }] });
        default:
          return void res.writeHead(202).end();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, hits };
}

async function setup(url: string, claude = false) {
  const dataDir = await mkdtemp(join(tmpdir(), "eta-test-server-"));
  dirs.push(dataDir);
  const dir = join(dataDir, "plugins", "demo");
  await mkdir(join(dir, ".claude-plugin"), { recursive: true });
  if (claude) {
    await writeFile(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo" }));
    await writeFile(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { remote: { type: "http", url, headers: { "X-Api-Key": "${API_KEY}" } } } }),
    );
  } else {
    await writeFile(join(dir, "plugin.json"), JSON.stringify({ $schema: PLUGIN, name: "demo" }));
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({ $schema: MCP, mcpServers: { remote: { type: "streamable-http", url } } }),
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
  const run = async (timeoutMs = 5000) => {
    const plan = plugins.testPlan("demo", "remote");
    if ("result" in plan) return plan.result;
    return testConnection(
      { ...plan.entry, name: "remote", source: "plugin-test", hash: "plugin-test" },
      plan.secrets,
      timeoutMs,
    );
  };
  return { plugins, run };
}

describe("testing a plugin server's connection", () => {
  it("lists tools with their parameters, counts resources, and names the server", async () => {
    const server = await fake();
    const { run } = await setup(server.url);
    const result = await run();
    expect(result.status).toBe("ok");
    expect(result).toMatchObject({ serverName: "fake", serverVersion: "1.2.3", toolCount: 1, resourceCount: 2, promptCount: null });
    expect(result.tools).toEqual([{ name: "echo", description: "says it back", params: ["text"] }]);
    expect(server.hits.some((hit) => hit.rpc === "tools/call")).toBe(false);
  });

  it("sends the user's header to its server", async () => {
    const server = await fake();
    const { plugins, run } = await setup(server.url);
    plugins.setHeaders("demo", "remote", [{ name: "Authorization", value: "Bearer " + SECRET, secret: true }]);
    expect((await run()).status).toBe("ok");
    expect(server.hits.some((hit) => hit.auth === "Bearer " + SECRET)).toBe(true);
  });

  it("says a 401 after the user's header was sent is a rejected credential", async () => {
    const server = await fake("401");
    const { plugins, run } = await setup(server.url);
    plugins.setHeaders("demo", "remote", [{ name: "Authorization", value: "Bearer " + SECRET, secret: true }]);
    const result = await run();
    expect(result.status).toBe("failed");
    expect(result.message).toContain("401");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("says a 401 with no credential at all needs a login", async () => {
    const server = await fake("401");
    const { run } = await setup(server.url);
    expect((await run()).status).toBe("needs_login");
  });

  it("says no answer within the time, and ends", async () => {
    const server = await fake("hang");
    const { run } = await setup(server.url);
    const result = await run(400);
    expect(result.status).toBe("failed");
    expect(result.message).toContain("no answer");
  });

  it("says when the server does not answer as MCP", async () => {
    const server = await fake("garbage");
    const { run } = await setup(server.url);
    const result = await run();
    expect(result.status).toBe("failed");
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("makes no connection when a required value is missing", async () => {
    const server = await fake();
    const { run } = await setup(server.url, true);
    const result = await run();
    expect(result.status).toBe("needs_setup");
    expect(server.hits).toHaveLength(0);
  });

  it("sends nothing when the plugin is off", async () => {
    const server = await fake();
    const { plugins, run } = await setup(server.url);
    plugins.setEnabled("demo", false);
    const result = await run();
    expect(result.status).toBe("off");
    expect(server.hits).toHaveLength(0);
  });

  it("never returns a secret, even one the server repeats", async () => {
    const server = await fake("leak");
    const { plugins, run } = await setup(server.url);
    plugins.setHeaders("demo", "remote", [{ name: "Authorization", value: "Bearer " + SECRET, secret: true }]);
    const result = await run();
    expect(result.status).toBe("ok");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.tools[0]!.description).toContain("***");
  });

  it("refuses a redirect to another origin, and the other origin sees nothing", async () => {
    const target = await fake();
    const server = await fake({ redirect: target.url });
    const { plugins, run } = await setup(server.url);
    plugins.setHeaders("demo", "remote", [{ name: "Authorization", value: "Bearer " + SECRET, secret: true }]);
    const result = await run();
    expect(result.status).toBe("failed");
    expect(result.message).toContain("another host");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(target.hits).toHaveLength(0);
  });
});
