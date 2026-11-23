/**
 * Signing in to a plugin's MCP server from the plugin's own panel, against a fake authorization
 * server: no agent is needed, nothing is asked before the call, an off plugin gets no login, a
 * wrong state is refused, and uninstalling drops a token only when no other plugin shares the URL.
 * No real service is contacted.
 */
import type { McpTuning } from "../src/product";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mcpServerKey } from "@eta/daemon";
import { describe, expect, it } from "vitest";
import {
  createFakeAuthServer,
  MCP_URL,
} from "../../../packages/eta-mcp/test/oauth/fake-auth-server";
import { CredentialRows } from "../src/mcp/credentials";
import { loadSecretKey } from "../src/secret";
import { connect, until } from "./support/client";
import { tempDir, testHost } from "./support/host";

const TOKEN = "correct-horse-battery-staple";
const ORIGIN = "https://eta.test";
const KEY = mcpServerKey(MCP_URL);
type FetchLike = NonNullable<McpTuning["fetch"]>;

/**
 * The fake authorization server, with an MCP endpoint that answers a request carrying a token it
 * issued (`access-<n>`): JSON-RPC over streamable HTTP, one tool `whoami`. Without one it is the
 * fake's 401, which is what sends a client to sign in.
 */
function withMcpEndpoint(
  auth: ReturnType<typeof createFakeAuthServer>,
): FetchLike {
  return async (input, init) => {
    const bearer = new Headers(init?.headers).get("authorization");
    if (String(input) !== MCP_URL || !bearer?.startsWith("Bearer access-"))
      return await auth.fetch(input, init);
    if ((init?.method ?? "GET") !== "POST")
      return new Response(null, { status: 405 });
    const message = JSON.parse(String(init?.body)) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "remote", version: "1.0.0" },
          }
        : message.method === "tools/list"
          ? {
              tools: [
                {
                  name: "whoami",
                  description: "Say who the token belongs to.",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            }
          : message.method === "tools/call"
            ? {
                content: [{ type: "text", text: "ada" }],
                structuredContent: { token: bearer.slice("Bearer ".length) },
              }
            : {};
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
}

async function plugin(dataDir: string, name: string): Promise<void> {
  const dir = join(dataDir, "plugins", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name,
    }),
  );
  await writeFile(
    join(dir, "mcp.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { remote: { type: "streamable-http", url: MCP_URL } },
    }),
  );
}

/** What a request carried: its address and the value of x-cursor-auth, a header the user saved. */
interface Seen {
  url: string;
  cursor: string | null;
}

async function setUp(seen: Seen[] = []) {
  const dataDir = await tempDir();
  await plugin(dataDir, "demo");
  await plugin(dataDir, "twin");
  const tokenFile = join(await tempDir("eta-token-"), "token");
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const auth = createFakeAuthServer();
  const host = await testHost({
    dataDir,
    tokenFile,
    mcp: {
      fetch: async (input, init) => {
        seen.push({
          url: String(input),
          cursor: new Headers(init?.headers).get("x-cursor-auth"),
        });
        return await withMcpEndpoint(auth)(input, init);
      },
      manager: { resolvers: false, checkIntervalMs: 0 },
    },
  });
  const client = await connect(`ws://127.0.0.1:${host.port}/ws`, {
    authorization: `Bearer ${TOKEN}`,
  });
  await client.hello();
  client.subscribe("plugins");
  const store = new CredentialRows(host.db, loadSecretKey(dataDir));
  const call = (method: string, args: Record<string, unknown>) =>
    client.call("plugins", method, args);
  const login = () =>
    call("loginServer", {
      name: "demo",
      server: "remote",
      redirectOrigin: ORIGIN,
    }) as Promise<{ pendingId: string; authorizationUrl: string }>;
  const callback = (query: string) =>
    fetch(`http://127.0.0.1:${host.port}/mcp/oauth/callback${query}`);
  return { host, auth, store, call, login, callback, client };
}

describe("a plugin server's login from its panel", () => {
  it("needs no agent: 401 -> login -> token, and the panel reads signed in", async () => {
    const s = await setUp();
    expect(s.store.has(KEY, "tokens")).toBe(false);
    const { pendingId, authorizationUrl } = await s.login();
    expect(new URL(authorizationUrl).searchParams.get("state")).toBe(pendingId);
    const redirect = new URL(s.auth.approve(authorizationUrl));
    expect((await s.callback(redirect.search)).status).toBe(200);
    expect(s.store.has(KEY, "tokens")).toBe(true);
    await until(() => {
      const list =
        s.client.section<{ name: string; servers: { login?: string }[] }[]>(
          "plugins",
          "list",
        ) ?? [];
      return (
        list.find((one) => one.name === "demo")?.servers[0]?.login ===
        "signed_in"
      );
    });
  }, 30_000);

  it("sends the headers the user saved for the server to its address, and to no other", async () => {
    const seen: Seen[] = [];
    const s = await setUp(seen);
    const value = "Bearer cursor-value-not-shown";
    await s.call("setHeaders", {
      name: "demo",
      server: "remote",
      headers: [{ name: "x-cursor-auth", value, secret: true }],
    });
    seen.length = 0;
    await s.login();
    const own = seen.filter(
      (one) => new URL(one.url).origin === "https://mcp.test",
    );
    expect(own.length).toBeGreaterThan(0);
    for (const one of own) expect(one.cursor).toBe(value);
    for (const one of seen.filter(
      (one) => new URL(one.url).origin !== "https://mcp.test",
    ))
      expect(one.cursor).toBeNull();
  }, 30_000);

  it("refuses a state it did not start", async () => {
    const s = await setUp();
    const { authorizationUrl } = await s.login();
    const redirect = new URL(s.auth.approve(authorizationUrl));
    const response = await s.callback(
      `?code=${redirect.searchParams.get("code")}&state=other`,
    );
    expect(response.status).toBe(400);
    expect(s.store.has(KEY, "tokens")).toBe(false);
  });

  it("gives no login for a plugin that is off", async () => {
    const s = await setUp();
    await s.call("setEnabled", { name: "demo", enabled: false });
    await expect(s.login()).rejects.toThrow();
    expect(s.auth.requests.length).toBe(0);
  });

  it("uninstall drops a token only when no other server uses the URL (token store rule)", async () => {
    const s = await setUp();
    const { authorizationUrl } = await s.login();
    expect(
      (await s.callback(new URL(s.auth.approve(authorizationUrl)).search))
        .status,
    ).toBe(200);
    expect(s.store.has(KEY, "tokens")).toBe(true);
    const mcp = s.host.product.mcp;
    // Another server still uses the URL: the token stays.
    await mcp.releaseUrls([MCP_URL], "demo", new Set([mcp.keyOf(MCP_URL)]));
    expect(s.store.has(KEY, "tokens")).toBe(true);
    // None does: it goes.
    await mcp.releaseUrls([MCP_URL], "demo", new Set());
    expect(s.store.has(KEY, "tokens")).toBe(false);
  }, 30_000);
});
