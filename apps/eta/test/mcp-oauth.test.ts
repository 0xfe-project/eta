/**
 * Signing in to MCP servers: the `mcp` target, the callback the browser returns to, the token
 * gate that must not stand in its way (and must stand in front of everything else), and a
 * daemon's use of the tokens, which stay on the primary.
 */
import type { McpServerView } from "@eta/client-contracts";
import type { McpTuning } from "../src/mcp/service";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mcpServerKey } from "@eta/daemon";
import { describe, expect, it } from "vitest";
import {
  createFakeAuthServer,
  MCP_URL,
} from "../../../packages/eta-mcp/test/oauth/fake-auth-server";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { CredentialRows } from "../src/mcp/credentials";
import { McpService } from "../src/mcp/service";
import { loadSecretKey } from "../src/secret";
import { filesContaining } from "./support/bundles";
import { connect, until } from "./support/client";
import { tempDir, testHost } from "./support/host";
import { call, say, scriptedModels } from "./support/models";
import { remoteWorld } from "./support/remote";

const TOKEN = "correct-horse-battery-staple";
const ORIGIN = "https://eta.test";
const KEY = mcpServerKey(MCP_URL);

/**
 * The fake MCP endpoint answers 401 to everyone, so a signed-in server would look as though its
 * token was refused. Let a request that carries a token get a different failure: the server is
 * down, which is not the token's fault.
 */
type FetchLike = NonNullable<McpTuning["fetch"]>;

function signedInIsDown(fetchFn: FetchLike): FetchLike {
  return async (input, init) => {
    const bearer = new Headers(init?.headers).get("authorization");
    if (String(input) === MCP_URL && bearer?.startsWith("Bearer access-"))
      return new Response("down", { status: 503 });
    return await fetchFn(input, init);
  };
}

async function setUp(options: { publicUrl?: string } = {}) {
  const dataDir = await tempDir();
  await mkdir(join(dataDir, ".eta"), { recursive: true });
  await writeFile(
    join(dataDir, ".eta", "mcp.json"),
    JSON.stringify({
      mcpServers: { remote: { url: MCP_URL, auth: "oauth" } },
    }),
  );
  const tokenFile = join(await tempDir("eta-token-"), "token");
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const server = createFakeAuthServer();
  const host = await testHost({
    dataDir,
    tokenFile,
    ...(options.publicUrl === undefined
      ? {}
      : { publicUrl: options.publicUrl }),
    mcp: { fetch: signedInIsDown(server.fetch) },
  });
  const client = await connect(`ws://127.0.0.1:${host.port}/ws`, {
    authorization: `Bearer ${TOKEN}`,
  });
  await client.hello();
  client.subscribe("mcp");
  const agent = (await client.call("agents", "create", { name: "Ada" })) as {
    agent: { id: string };
  };
  const agentId = agent.agent.id;
  const views = () => client.section<McpServerView[]>("mcp", "list") ?? [];
  const remote = () => views().find((view) => view.server === "remote");
  await until(() => remote() !== undefined);
  /** `null`: a client that does not say where it reached the host. */
  const login = async (redirectOrigin: string | null = ORIGIN) =>
    (await client.call("mcp", "login", {
      agentId,
      server: "remote",
      ...(redirectOrigin === null ? {} : { redirectOrigin }),
    })) as { pendingId: string; authorizationUrl: string };
  const callback = (query: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${host.port}/mcp/oauth/callback${query}`, init);
  const store = new CredentialRows(host.db, loadSecretKey(dataDir));
  return {
    dataDir,
    host,
    client,
    server,
    agentId,
    views,
    remote,
    login,
    callback,
    store,
  };
}

describe("listing an agent's servers", () => {
  it("shows where each comes from, how it is reached and that it needs a login", async () => {
    const s = await setUp();
    expect(s.remote()).toMatchObject({
      agentId: s.agentId,
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
});

describe("signing in through the browser", () => {
  it("completes at the callback without the token, and the server is then signed in", async () => {
    const s = await setUp();
    const { pendingId, authorizationUrl } = await s.login();
    expect(pendingId).toBe(new URL(authorizationUrl).searchParams.get("state"));
    // The redirect is the origin the client reached the host at, plus the callback path.
    expect(new URL(authorizationUrl).searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/mcp/oauth/callback`,
    );

    const redirect = new URL(s.server.approve(authorizationUrl));
    // No cookie, no bearer: the browser arrives from the provider.
    const response = await s.callback(redirect.search);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("close this tab");

    await until(() => s.remote()?.auth === "signed_in");
    expect(s.store.has(KEY, "tokens")).toBe(true);
    // The code is single use: a second visit finds no sign-in waiting.
    expect((await s.callback(redirect.search)).status).toBe(400);
  });

  it("does nothing for a state it did not issue, and leaves the real login waiting", async () => {
    const s = await setUp();
    const { authorizationUrl } = await s.login();
    const redirect = new URL(s.server.approve(authorizationUrl));

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
    expect(s.remote()?.auth).toBe("needs_login");

    // The right redirect still completes it.
    expect((await s.callback(redirect.search)).status).toBe(200);
    await until(() => s.remote()?.auth === "signed_in");
  });

  it("lets nothing else through the token gate: other paths, other methods", async () => {
    const s = await setUp();
    const { authorizationUrl } = await s.login();
    const redirect = new URL(s.server.approve(authorizationUrl));
    const base = `http://127.0.0.1:${s.host.port}`;

    expect(
      (await fetch(`${base}/mcp/oauth/callback/more${redirect.search}`)).status,
    ).toBe(401);
    expect((await fetch(`${base}/mcp/oauth${redirect.search}`)).status).toBe(
      401,
    );
    expect((await fetch(`${base}/mcp${redirect.search}`)).status).toBe(401);
    expect((await s.callback(redirect.search, { method: "POST" })).status).toBe(
      401,
    );
    expect(
      (await s.callback(redirect.search, { method: "DELETE" })).status,
    ).toBe(401);
    // None of that touched the login.
    expect(s.store.has(KEY, "tokens")).toBe(false);
    expect(s.remote()?.auth).toBe("needs_login");
  });

  it("uses the configured public address for the redirect, whatever the client reports", async () => {
    const s = await setUp({ publicUrl: "https://public.example.com/ignored" });
    const { authorizationUrl } = await s.login("https://elsewhere.test");
    expect(new URL(authorizationUrl).searchParams.get("redirect_uri")).toBe(
      "https://public.example.com/mcp/oauth/callback",
    );
  });

  it("refuses to sign in with no address to return to, and for a server that is not OAuth", async () => {
    const s = await setUp();
    await expect(s.login(null)).rejects.toThrow(/--public-url/);
    await expect(s.login("not a url")).rejects.toThrow(/--public-url/);
    await expect(
      s.client.call("mcp", "login", {
        agentId: s.agentId,
        server: "nope",
        redirectOrigin: ORIGIN,
      }),
    ).rejects.toThrow(/no MCP server/);
  });
});

describe("signing in headless", () => {
  it("completes from the pasted redirect URL, and a wrong state changes nothing", async () => {
    const s = await setUp();
    const { pendingId, authorizationUrl } = await s.login();
    const redirect = s.server.approve(authorizationUrl);

    const forged = new URL(redirect);
    forged.searchParams.set("state", "forged");
    await expect(
      s.client.call("mcp", "completeLogin", {
        pendingId,
        callbackUrl: forged.toString(),
      }),
    ).rejects.toThrow(/state/i);
    expect(s.store.has(KEY, "tokens")).toBe(false);

    await s.client.call("mcp", "completeLogin", {
      pendingId,
      callbackUrl: redirect,
    });
    await until(() => s.remote()?.auth === "signed_in");
    await expect(
      s.client.call("mcp", "completeLogin", {
        pendingId,
        callbackUrl: redirect,
      }),
    ).rejects.toThrow(/No pending login/);
  });

  it("signs out: the credentials are gone", async () => {
    const s = await setUp();
    const { pendingId, authorizationUrl } = await s.login();
    await s.client.call("mcp", "completeLogin", {
      pendingId,
      callbackUrl: s.server.approve(authorizationUrl),
    });
    await until(() => s.remote()?.auth === "signed_in");

    await s.client.call("mcp", "logout", {
      agentId: s.agentId,
      server: "remote",
    });
    await until(() => s.remote()?.auth === "needs_login");
    expect(s.store.has(KEY, "tokens")).toBe(false);
    expect(s.store.has(KEY, "clientInformation")).toBe(false);
  });
});

describe("a daemon's use of the tokens", () => {
  it("reads them from the primary and saves a refresh there, keeping none itself", async () => {
    const server = createFakeAuthServer();
    const { models } = scriptedModels((request) =>
      request.lastRole === "toolResult"
        ? say("done")
        : call("mcp", { connect: "remote" }),
    );
    const dataDir = await tempDir();
    const r = await remoteWorld(
      { dataDir, models, mcp: { fetch: server.fetch } },
      { mcp: { fetch: server.fetch, resolvers: false, checkIntervalMs: 0 } },
    );
    await writeFile(
      join(r.dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { remote: { url: MCP_URL, auth: "oauth" } },
      }),
    );
    const { agents, group } = await r.agents("Ada");

    // Sign in on the primary, for an agent whose global file names the same server.
    await mkdir(join(dataDir, ".eta"), { recursive: true });
    await writeFile(
      join(dataDir, ".eta", "mcp.json"),
      JSON.stringify({
        mcpServers: { remote: { url: MCP_URL, auth: "oauth" } },
      }),
    );
    const { pendingId, authorizationUrl } = (await r.client.call(
      "mcp",
      "login",
      {
        agentId: agents[0]!.id,
        server: "remote",
        redirectOrigin: ORIGIN,
      },
    )) as { pendingId: string; authorizationUrl: string };
    await r.client.call("mcp", "completeLogin", {
      pendingId,
      callbackUrl: server.approve(authorizationUrl),
    });
    const store = new CredentialRows(r.host.db, loadSecretKey(dataDir));
    // Signing in makes the primary's own connection try the server at once; let that finish.
    let seen = -1;
    await until(async () => {
      const now = server.tokenRequests("refresh_token");
      await new Promise((resolve) => setTimeout(resolve, 150));
      const settled =
        now === seen && now === server.tokenRequests("refresh_token");
      seen = now;
      return settled;
    });
    const before = (await store.get(KEY, "tokens"))!.refresh_token;
    const refreshes = server.tokenRequests("refresh_token");

    // The daemon's session tries the server: the fake answers 401 whatever the token, so the SDK
    // refreshes the token it was handed over the link, and the new one is saved on the primary.
    const sent = await r.send(group.id, "connect");
    await r.settled(group.id, sent.replies[0]!.id);
    await until(() => server.tokenRequests("refresh_token") > refreshes);
    await until(async () => {
      const now = await store.get(KEY, "tokens");
      return now !== undefined && now.refresh_token !== before;
    });
    // It reached the server with the primary's credentials; the daemon's own disk has none.
    expect(await filesContaining(r.daemon.dataDir, "refresh-")).toEqual([]);
    expect(await filesContaining(r.daemon.dataDir, "access-")).toEqual([]);
  });

  it("may only touch the three pieces of state it needs, under a server's key", async () => {
    const db = openDatabase(join(await tempDir(), "eta.db"));
    applyMigrations(db, loadMigrations());
    const dataDir = await tempDir();
    const service = new McpService({
      db,
      key: loadSecretKey(dataDir),
      dataDir,
      home: dataDir,
      agents: () => [],
      bundleSources: () => [],
      changed: () => undefined,
      warn: () => undefined,
    });
    const tokens = { access_token: "a", token_type: "Bearer" };
    await service.relay({
      op: "set",
      serverKey: KEY,
      kind: "tokens",
      value: tokens,
    });
    expect(
      await service.relay({ op: "get", serverKey: KEY, kind: "tokens" }),
    ).toEqual(tokens);
    await service.relay({ op: "delete", serverKey: KEY, kind: "tokens" });
    expect(
      await service.relay({ op: "get", serverKey: KEY, kind: "tokens" }),
    ).toBeNull();

    // A login's PKCE verifier, a key that is not a server's, another operation: none of it.
    for (const call of [
      { op: "get", serverKey: KEY, kind: "codeVerifier" },
      { op: "set", serverKey: KEY, kind: "codeVerifier", value: "x" },
      { op: "get", serverKey: "../../etc", kind: "tokens" },
      { op: "get", serverKey: KEY.toUpperCase(), kind: "tokens" },
      { op: "wipe", serverKey: KEY, kind: "tokens" },
    ])
      await expect(service.relay(call as never)).rejects.toThrow(
        /mcp.credential/,
      );
    await service.close();
  });
});
