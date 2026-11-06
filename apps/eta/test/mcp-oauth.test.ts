/**
 * MCP OAuth on the host, end to end against a fake authorization server: `login` on the `mcp`
 * target, the browser's return to `/mcp/oauth/callback` (which needs no token, while nothing else
 * gets through without one), the sealed tokens, the server connecting with them, and a session's
 * `import "mcp:<server>"` calling its tool.
 */
import type { McpServerView } from "@eta/client-contracts";
import type { McpTuning } from "../src/product";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFakeAuthServer,
  MCP_URL,
} from "../../../packages/eta-mcp/test/oauth/fake-auth-server";
import { CredentialRows } from "../src/mcp/credentials";
import { mcpServerKey } from "../src/mcp/service";
import { loadSecretKey } from "../src/secret";
import { connect, until } from "./support/client";
import { tempDir, testHost } from "./support/host";

const TOKEN = "correct-horse-battery-staple";
const ORIGIN = "https://eta.test";
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

async function setUp(options: { publicUrl?: string } = {}) {
  const dataDir = await tempDir();
  await mkdir(join(dataDir, ".eta"), { recursive: true });
  await writeFile(
    join(dataDir, ".eta", "mcp.json"),
    JSON.stringify({
      // `approveTools` is still read, and no longer asks anything.
      mcpServers: {
        remote: { url: MCP_URL, auth: "oauth", approveTools: true },
      },
    }),
  );
  const tokenFile = join(await tempDir("eta-token-"), "token");
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const auth = createFakeAuthServer();
  const host = await testHost({
    dataDir,
    tokenFile,
    ...(options.publicUrl === undefined
      ? {}
      : { publicUrl: options.publicUrl }),
    mcp: {
      fetch: withMcpEndpoint(auth),
      manager: { resolvers: false, checkIntervalMs: 0 },
    },
  });
  const client = await connect(`ws://127.0.0.1:${host.port}/ws`, {
    authorization: `Bearer ${TOKEN}`,
  });
  await client.hello();
  client.subscribe("mcp");
  const created = (await client.call("agents", "create", { name: "Ada" })) as {
    agent: { id: string };
  };
  const agentId = created.agent.id;
  const views = () => client.section<McpServerView[]>("mcp", "list") ?? [];
  const remote = () =>
    views().find(
      (view) => view.agentId === agentId && view.server === "remote",
    );
  await until(() => remote() !== undefined);
  const login = async (redirectOrigin: string | null = ORIGIN) =>
    (await client.call("mcp", "login", {
      agentId,
      server: "remote",
      ...(redirectOrigin === null ? {} : { redirectOrigin }),
    })) as { pendingId: string; authorizationUrl: string };
  const base = `http://127.0.0.1:${host.port}`;
  const callback = (query: string, init: RequestInit = {}) =>
    fetch(`${base}/mcp/oauth/callback${query}`, init);
  const store = new CredentialRows(host.db, loadSecretKey(dataDir));
  return { host, client, auth, agentId, remote, login, base, callback, store };
}

const KEY = mcpServerKey(MCP_URL);

describe("signing in to an OAuth MCP server", () => {
  it("lists the server as needing a login before anyone signs in", async () => {
    const s = await setUp();
    expect(s.remote()).toMatchObject({
      agentName: "Ada",
      source: "~/.eta/mcp.json",
      transport: "http",
      lifecycle: "lazy",
      state: "not-connected",
      toolCount: 0,
      error: null,
      auth: "needs_login",
    });
  });

  it("goes from login to a session's import calling the tool", async () => {
    const s = await setUp();
    const { pendingId, authorizationUrl } = await s.login();
    expect(new URL(authorizationUrl).searchParams.get("state")).toBe(pendingId);
    expect(new URL(authorizationUrl).searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/mcp/oauth/callback`,
    );

    // The browser comes back from the provider with no cookie and no bearer.
    const redirect = new URL(s.auth.approve(authorizationUrl));
    const response = await s.callback(redirect.search);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("close this tab");
    expect(s.store.has(KEY, "tokens")).toBe(true);

    // Signing in connects the servers that were waiting for it.
    await until(() => s.remote()?.state === "connected", 10_000);
    expect(s.remote()).toMatchObject({
      auth: "signed_in",
      toolCount: 1,
      error: null,
    });

    // A session reaches the server with the stored token, and nothing asks for approval.
    const cwd = await tempDir("eta-mcp-project-");
    const { session } = await s.host.server.sessions.create({ cwd });
    const result = await session.esm!.agent.run(`
      import { whoami } from "mcp:remote";
      export default await whoami({});
    `);
    expect(result.value).toEqual({ token: expect.stringMatching(/^access-/) });
    expect(result.effects.map((effect) => effect.name)).toContain(
      "mcp.remote.whoami",
    );

    // The code is single use.
    expect((await s.callback(redirect.search)).status).toBe(400);
  }, 30_000);

  it("ignores a state it did not issue and keeps the real login waiting", async () => {
    const s = await setUp();
    const { authorizationUrl } = await s.login();
    const redirect = new URL(s.auth.approve(authorizationUrl));
    for (const query of [
      `?code=${redirect.searchParams.get("code")}&state=not-the-state`,
      `?code=${redirect.searchParams.get("code")}`,
      "",
    ]) {
      const response = await s.callback(query);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Sign-in not found");
    }
    expect(s.store.has(KEY, "tokens")).toBe(false);
    expect((await s.callback(redirect.search)).status).toBe(200);
    await until(() => s.remote()?.auth === "signed_in");
  });

  it("lets nothing else past the token gate", async () => {
    const s = await setUp();
    const { authorizationUrl } = await s.login();
    const redirect = new URL(s.auth.approve(authorizationUrl));
    for (const path of ["/mcp/oauth/callback/more", "/mcp/oauth", "/mcp", "/"])
      expect((await fetch(`${s.base}${path}${redirect.search}`)).status).toBe(
        401,
      );
    for (const method of ["POST", "DELETE"])
      expect((await s.callback(redirect.search, { method })).status).toBe(401);
    expect(s.store.has(KEY, "tokens")).toBe(false);
  });

  it("returns to the configured public address, whatever the client says", async () => {
    const s = await setUp({ publicUrl: "https://public.example.com/ignored" });
    const { authorizationUrl } = await s.login("https://elsewhere.test");
    expect(new URL(authorizationUrl).searchParams.get("redirect_uri")).toBe(
      "https://public.example.com/mcp/oauth/callback",
    );
  });

  it("refuses with no address to return to, and for a server it does not have", async () => {
    const s = await setUp();
    await expect(s.login(null)).rejects.toThrow(/--public-url/);
    await expect(
      s.client.call("mcp", "login", {
        agentId: s.agentId,
        server: "nope",
        redirectOrigin: ORIGIN,
      }),
    ).rejects.toThrow(/no MCP server/);
  });

  it("completes from a pasted redirect URL, and signs out again", async () => {
    const s = await setUp();
    const { pendingId, authorizationUrl } = await s.login();
    const redirect = s.auth.approve(authorizationUrl);
    const forged = new URL(redirect);
    forged.searchParams.set("state", "forged");
    await expect(
      s.client.call("mcp", "completeLogin", {
        pendingId,
        callbackUrl: forged.href,
      }),
    ).rejects.toThrow(/state/i);
    await s.client.call("mcp", "completeLogin", {
      pendingId,
      callbackUrl: redirect,
    });
    await until(() => s.remote()?.auth === "signed_in");

    await s.client.call("mcp", "logout", {
      agentId: s.agentId,
      server: "remote",
    });
    await until(() => s.remote()?.auth === "needs_login");
    expect(s.store.has(KEY, "tokens")).toBe(false);
  });
});
