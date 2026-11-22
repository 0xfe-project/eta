import type { AuthProviderFor } from "@eta/mcp";
import type { AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
/**
 * The connection test of a plugin server: lists tools, resources and prompts, never calls one, and
 * says why when it cannot. Local fake servers answer; no real server is asked.
 */
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOAuthProvider } from "@eta/mcp";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { Plugins } from "../src/plugins/service";
import { testConnection } from "../src/plugins/test-server";

/** The host's own provider over a store holding the token a login left (none can start a login here). */
const storedProvider =
  (token: string, refresh?: string): AuthProviderFor =>
  (_name, context) => {
    const rows = new Map<string, unknown>([
      [
        "tokens",
        {
          access_token: token,
          token_type: "Bearer",
          ...(refresh ? { refresh_token: refresh } : {}),
        },
      ],
      ...(refresh
        ? ([
            [
              "clientInformation",
              {
                client_id: "fake-client",
                redirect_uris: ["http://127.0.0.1/mcp/oauth/callback"],
              },
            ],
          ] as const)
        : []),
    ]);
    return createOAuthProvider({
      serverKey: "k",
      serverUrl: context.url,
      redirectUrl: "http://127.0.0.1/mcp/oauth/callback",
      store: {
        get: async (_key: string, kind: string) => rows.get(kind),
        set: async (_key: string, kind: string, value: unknown) =>
          void rows.set(kind, value),
        delete: async (_key: string, kind: string) => void rows.delete(kind),
      } as never,
    });
  };

const PLUGIN = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const SECRET = "s3cr3t-value-123";

const dirs: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    server.close();
  }
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

interface Fake {
  url: string;
  hits: { method: string; auth: string | undefined; rpc: string }[];
  /** Refresh requests the token endpoint accepted. */
  readonly refreshes: number;
}

/** A minimal streamable-HTTP MCP server; `mode` picks how it misbehaves. */
async function fake(
  mode:
    | "ok"
    | "401"
    | "challenge"
    | "token"
    | "hang"
    | { redirect: string }
    | "leak"
    | "garbage" = "ok",
): Promise<Fake> {
  const hits: Fake["hits"] = [];
  let refreshes = 0;
  const server = http.createServer((req, res) => {
    const origin = `http://${req.headers.host}`;
    // "token" mode publishes its OAuth metadata at the path-suffixed URL only, as the challenge says.
    if (
      mode === "token" &&
      req.url === "/.well-known/oauth-protected-resource/mcp"
    )
      return void res
        .writeHead(200, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            resource: `${origin}/mcp`,
            authorization_servers: [origin],
          }),
        );
    if (
      mode === "token" &&
      req.url?.startsWith("/.well-known/oauth-authorization-server")
    )
      return void res
        .writeHead(200, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          }),
        );
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (mode === "token" && req.method === "POST" && req.url === "/token") {
        const form = new URLSearchParams(body);
        if (
          form.get("grant_type") === "refresh_token" &&
          form.get("refresh_token") === "refresh-ok"
        ) {
          refreshes++;
          return void res
            .writeHead(200, { "content-type": "application/json" })
            .end(
              JSON.stringify({
                access_token: "access-stored",
                token_type: "Bearer",
                refresh_token: "refresh-ok",
                expires_in: 3600,
              }),
            );
        }
        return void res
          .writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "invalid_grant" }));
      }
      let rpc: {
        id?: number;
        method?: string;
        params?: { protocolVersion?: string };
      } = {};
      try {
        rpc = JSON.parse(body);
      } catch {
        // A GET has no body.
      }
      hits.push({
        method: req.method ?? "",
        auth: req.headers.authorization,
        rpc: rpc.method ?? "",
      });
      if (mode === "hang") return;
      // "token": a server that signs in with OAuth; only the token the test below stores gets in.
      if (
        mode === "token" &&
        req.headers.authorization !== "Bearer access-stored"
      )
        return void res
          .writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
          })
          .end("no");
      if (mode === "401") return void res.writeHead(401).end("no");
      if (mode === "challenge")
        return void res
          .writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="OAuth access token required"`,
          })
          .end("no");
      if (typeof mode === "object")
        return void res.writeHead(302, { location: mode.redirect }).end();
      if (mode === "garbage")
        return void res
          .writeHead(200, { "content-type": "application/json" })
          .end("not json at all");
      if (req.method !== "POST") return void res.writeHead(405).end();
      const reply = (result: unknown) =>
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
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
                description:
                  mode === "leak"
                    ? `sent ${req.headers.authorization ?? ""}`
                    : "says it back",
                inputSchema: { type: "object", properties: { text: {} } },
              },
            ],
          });
        case "resources/list":
          return reply({
            resources: [
              { uri: "a://b", name: "b" },
              { uri: "a://c", name: "c" },
            ],
          });
        default:
          return void res.writeHead(202).end();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    hits,
    get refreshes() {
      return refreshes;
    },
  };
}

async function setup(url: string, claude = false) {
  const dataDir = await mkdtemp(join(tmpdir(), "eta-test-server-"));
  dirs.push(dataDir);
  const dir = join(dataDir, "plugins", "demo");
  await mkdir(join(dir, ".claude-plugin"), { recursive: true });
  if (claude) {
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
        mcpServers: { remote: { type: "streamable-http", url } },
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
  const run = async (timeoutMs = 5000, stored?: AuthProviderFor) => {
    const plan = plugins.testPlan("demo", "remote");
    if ("result" in plan) return plan.result;
    return testConnection(
      {
        ...plan.entry,
        name: "remote",
        source: "plugin-test",
        hash: "plugin-test",
      },
      plan.secrets,
      timeoutMs,
      stored,
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
    expect(result).toMatchObject({
      serverName: "fake",
      serverVersion: "1.2.3",
      toolCount: 1,
      resourceCount: 2,
      promptCount: null,
    });
    expect(result.tools).toEqual([
      { name: "echo", description: "says it back", params: ["text"] },
    ]);
    expect(server.hits.some((hit) => hit.rpc === "tools/call")).toBe(false);
  });

  it("sends the user's header to its server", async () => {
    const server = await fake();
    const { plugins, run } = await setup(server.url);
    plugins.setHeaders("demo", "remote", [
      { name: "Authorization", value: `Bearer ${SECRET}`, secret: true },
    ]);
    expect((await run()).status).toBe("ok");
    expect(server.hits.some((hit) => hit.auth === `Bearer ${SECRET}`)).toBe(
      true,
    );
  });

  it("says a 401 after the user's header was sent is a rejected credential", async () => {
    const server = await fake("401");
    const { plugins, run } = await setup(server.url);
    plugins.setHeaders("demo", "remote", [
      { name: "Authorization", value: `Bearer ${SECRET}`, secret: true },
    ]);
    const result = await run();
    expect(result.status).toBe("failed");
    expect(result.message).toContain("401");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("an OAuth challenge with no header is a login, whatever the config default", async () => {
    const server = await fake("challenge");
    const { run } = await setup(server.url);
    const result = await run();
    expect(result.status).toBe("needs_login");
    expect(result.message).not.toContain("rejected");
  });

  it("an empty Authorization row is nothing: not sent, still a login", async () => {
    const server = await fake("challenge");
    const { plugins, run } = await setup(server.url);
    expect(() =>
      plugins.setHeaders("demo", "remote", [
        { name: "Authorization", value: "", secret: true },
      ]),
    ).toThrow();
    expect((await run()).status).toBe("needs_login");
    expect(server.hits.every((hit) => hit.auth === undefined)).toBe(true);
  });

  it("a real header the server still refuses, with a challenge, says rejected and also offers login", async () => {
    const server = await fake("challenge");
    const { plugins, run } = await setup(server.url);
    plugins.setHeaders("demo", "remote", [
      { name: "Authorization", value: `Bearer ${SECRET}`, secret: true },
    ]);
    const result = await run();
    expect(result.status).toBe("needs_login");
    expect(result.message).toContain("credential rejected");
    expect(result.message).toContain("login");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("sends the stored sign-in, so a logged-in server is listed, not asked to log in again", async () => {
    const server = await fake("token");
    const { run } = await setup(server.url);
    const result = await run(5000, storedProvider("access-stored"));
    expect(result.status).toBe("ok");
    expect(result.tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(server.hits.some((hit) => hit.auth === "Bearer access-stored")).toBe(
      true,
    );
  });

  it("says needs login when the stored sign-in is rejected, and starts no login", async () => {
    const server = await fake("token");
    const { run } = await setup(server.url);
    const result = await run(5000, storedProvider("access-expired"));
    expect(result.status).toBe("needs_login");
    expect(result.message).toContain("sign in again");
    expect(JSON.stringify(result)).not.toContain("access-expired");
  });

  it("an expired token with a valid refresh token is refreshed, and the test succeeds", async () => {
    const server = await fake("token");
    const { run } = await setup(server.url);
    const result = await run(
      5000,
      storedProvider("access-expired", "refresh-ok"),
    );
    expect(result.status).toBe("ok");
    expect(result.tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(server.refreshes).toBe(1);
    expect(JSON.stringify(result)).not.toContain("refresh-ok");
  });

  it("a rejected token whose refresh also fails says needs login", async () => {
    const server = await fake("token");
    const { run } = await setup(server.url);
    const result = await run(
      5000,
      storedProvider("access-expired", "refresh-revoked"),
    );
    expect(result.status).toBe("needs_login");
    expect(server.refreshes).toBe(0);
  });

  it("without a stored sign-in (logged out) says needs login", async () => {
    const server = await fake("token");
    const { run } = await setup(server.url);
    expect((await run()).status).toBe("needs_login");
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
    plugins.setHeaders("demo", "remote", [
      { name: "Authorization", value: `Bearer ${SECRET}`, secret: true },
    ]);
    const result = await run();
    expect(result.status).toBe("ok");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.tools[0]!.description).toContain("***");
  });

  it("refuses a redirect to another origin, and the other origin sees nothing", async () => {
    const target = await fake();
    const server = await fake({ redirect: target.url });
    const { plugins, run } = await setup(server.url);
    plugins.setHeaders("demo", "remote", [
      { name: "Authorization", value: `Bearer ${SECRET}`, secret: true },
    ]);
    const result = await run();
    expect(result.status).toBe("failed");
    expect(result.message).toContain("another host");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(target.hits).toHaveLength(0);
  });
});
