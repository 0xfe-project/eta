/**
 * The connection test right after a real sign-in (the host's own login and callback against a fake
 * authorization server, not a hand-written token store): what it sends, what it says when the server
 * says no, and whether the stored sign-in survives the test. Nothing here reaches a real service.
 */
import type { AuthProviderFor } from "@eta/mcp";
import type { McpTuning } from "../src/product";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mcpServerKey } from "@eta/daemon";
import { createOAuthProvider } from "@eta/mcp";
import { describe, expect, it } from "vitest";
import {
  createFakeAuthServer,
  MCP_URL,
} from "../../../packages/eta-mcp/test/oauth/fake-auth-server";
import { CredentialRows } from "../src/mcp/credentials";
import { testConnection } from "../src/plugins/test-server";
import { loadSecretKey } from "../src/secret";
import { connect } from "./support/client";
import { tempDir, testHost } from "./support/host";

const TOKEN = "correct-horse-battery-staple";
const ORIGIN = "https://eta.test";
type FetchLike = NonNullable<McpTuning["fetch"]>;

interface Rig {
  /** Tokens the MCP endpoint turns away with the given 401 challenge. */
  dead: Set<string>;
  /** When set, every token gets this 401 challenge (a rejection that is not an expiry). */
  always: string | null;
  /** When set, every request is refused with this body and no challenge (a server wanting a header of its own). */
  noChallenge: string | ((carried: string) => string) | null;
  /** When true, a request needs `x-cursor-auth: Bearer …` next to its sign-in (a bare value is "missing"). */
  cursorLayer?: boolean;
  /** Header names of every request that went to the OAuth server (metadata, register, authorize, token, refresh). */
  authHeaders: string[][];
  /** What each MCP request carried: whether an Authorization header, and how long. */
  seen: {
    auth: boolean;
    length: number;
    headers: Record<string, number>;
    values: Record<string, string>;
  }[];
}

function endpoint(
  auth: ReturnType<typeof createFakeAuthServer>,
  rig: Rig,
): FetchLike {
  return async (input, init) => {
    if (String(input) !== MCP_URL) {
      rig.authHeaders.push([...new Headers(init?.headers).keys()]);
      return await auth.fetch(input, init);
    }
    const bearer = new Headers(init?.headers).get("authorization");
    const all = new Headers(init?.headers);
    // Names and lengths are what the assertions print; `values` is read by the tests that compare to a token.
    rig.seen.push({
      auth: bearer !== null,
      length: bearer?.length ?? 0,
      headers: Object.fromEntries(
        [...all.entries()].map(([name, value]) => [name, value.length]),
      ),
      values: Object.fromEntries(all.entries()),
    });
    const token = bearer?.startsWith("Bearer access-")
      ? bearer.slice(7)
      : undefined;
    if (token === undefined) return await auth.fetch(input, init);
    if (
      rig.cursorLayer === true &&
      !(all.get("x-cursor-auth") ?? "").startsWith("Bearer ")
    )
      return new Response(
        '{"error":"unauthorized","message":"Missing Cursor credential in x-cursor-auth"}',
        { status: 401 },
      );
    if (rig.noChallenge !== null)
      return new Response(
        typeof rig.noChallenge === "function"
          ? rig.noChallenge(all.get("x-cursor-auth") ?? "")
          : rig.noChallenge,
        { status: 401 },
      );
    const challenge =
      rig.always ??
      (rig.dead.has(token)
        ? 'Bearer error="invalid_token", error_description="the access token expired"'
        : null);
    if (challenge !== null)
      return new Response(`denied for ${token}`, {
        status: 401,
        headers: { "www-authenticate": challenge },
      });
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
                  description: "who",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
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

async function signedIn() {
  const dataDir = await tempDir();
  await mkdir(join(dataDir, ".eta"), { recursive: true });
  await writeFile(
    join(dataDir, ".eta", "mcp.json"),
    JSON.stringify({ mcpServers: { remote: { url: MCP_URL, auth: "oauth" } } }),
  );
  const tokenFile = join(await tempDir("eta-token-"), "token");
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const auth = createFakeAuthServer();
  const rig: Rig = {
    dead: new Set(),
    always: null,
    noChallenge: null,
    authHeaders: [],
    seen: [],
  };
  const fetchImpl = endpoint(auth, rig);
  const host = await testHost({
    dataDir,
    tokenFile,
    mcp: {
      fetch: fetchImpl,
      manager: { resolvers: false, checkIntervalMs: 0 },
    },
  });
  const client = await connect(`ws://127.0.0.1:${host.port}/ws`, {
    authorization: `Bearer ${TOKEN}`,
  });
  await client.hello();
  const created = (await client.call("agents", "create", {
    name: "Ada",
    model: "fake:fake-model",
  })) as {
    agent: { id: string };
  };
  // The real login: the host's own authorization URL, the browser's return to its callback.
  const login = (await client.call("mcp", "login", {
    agentId: created.agent.id,
    server: "remote",
    redirectOrigin: ORIGIN,
  })) as { authorizationUrl: string };
  const redirect = new URL(auth.approve(login.authorizationUrl));
  const response = await fetch(
    `http://127.0.0.1:${host.port}/mcp/oauth/callback${redirect.search}`,
  );
  expect(response.status).toBe(200);
  const store = new CredentialRows(host.db, loadSecretKey(dataDir));
  const key = mcpServerKey(MCP_URL);
  expect(store.has(key, "tokens")).toBe(true);
  const provider: AuthProviderFor = (_name, context) =>
    createOAuthProvider({
      serverKey: mcpServerKey(context.url),
      serverUrl: context.url,
      store,
      redirectUrl: `${ORIGIN}/mcp/oauth/callback`,
    });
  const test = (extra: Record<string, unknown> = {}) => {
    rig.seen.length = 0;
    return testConnection(
      {
        name: "remote",
        url: MCP_URL,
        auth: "oauth",
        source: "plugin-test",
        hash: "plugin-test",
        ...extra,
      } as never,
      [],
      5000,
      provider,
      fetchImpl as never,
    );
  };
  return {
    auth,
    rig,
    store,
    key,
    test,
    access: async () => (await store.get(key, "tokens"))?.access_token,
  };
}

describe("the connection test right after a real sign-in", () => {
  it("succeeds, sends the stored token, and leaves the sign-in stored", async () => {
    const s = await signedIn();
    const result = await s.test();
    expect(result).toMatchObject({ status: "ok", toolCount: 1 });
    expect(s.rig.seen.some((one) => one.auth && one.length > 7)).toBe(true);
    expect(s.store.has(s.key, "tokens")).toBe(true);
    expect(s.auth.tokenRequests("refresh_token")).toBe(0);
  }, 30_000);

  it("refreshes an expired access token once, then succeeds", async () => {
    const s = await signedIn();
    s.rig.dead.add((await s.access())!);
    const result = await s.test();
    expect(result.status).toBe("ok");
    expect(s.auth.tokenRequests("refresh_token")).toBe(1);
    expect(await s.access()).not.toBe([...s.rig.dead][0]);
  }, 30_000);

  it("says the sign-in is no longer accepted when the refresh fails too, with the server's words", async () => {
    const s = await signedIn();
    s.rig.dead.add((await s.access())!);
    s.auth.revokeRefreshTokens();
    const result = await s.test();
    expect(result.status).toBe("needs_login");
    expect(result.message).toContain("invalid_token");
    expect(result.message).toContain("the access token expired");
    expect(JSON.stringify(result)).not.toContain("access-");
    // The refresh was tried first; only a refresh the server refuses (invalid_grant) drops the sign-in.
    expect(s.auth.tokenRequests("refresh_token")).toBe(1);
    expect(s.store.has(s.key, "tokens")).toBe(false);
  }, 30_000);

  it("shows the server's reason for a 401 that is not an expiry, and keeps the sign-in", async () => {
    const s = await signedIn();
    s.rig.always =
      'Bearer error="insufficient_scope", error_description="scope drive.read is required"';
    const result = await s.test();
    expect(result.status).toBe("needs_login");
    expect(result.message).toContain("insufficient_scope");
    expect(result.message).toContain("scope drive.read is required");
    expect(result.message).not.toContain("expired");
    expect(JSON.stringify(result)).not.toContain("access-");
    // A refresh that works means the stored sign-in is not thrown away by a refused request.
    expect(s.store.has(s.key, "tokens")).toBe(true);
  }, 30_000);

  it("names the header a server wants, does not say expired, and keeps the sign-in", async () => {
    const s = await signedIn();
    s.rig.noChallenge =
      '{"error":"unauthorized","message":"Missing Cursor credential in x-cursor-auth"}';
    const result = await s.test();
    expect(result.status).toBe("failed");
    expect(result.requiredHeader).toBe("x-cursor-auth");
    expect(result.message).toContain("x-cursor-auth");
    expect(result.message.toLowerCase()).not.toContain("expired");
    expect(JSON.stringify(result)).not.toContain("access-");
    expect(s.store.has(s.key, "tokens")).toBe(true);
    // What was sent: the OAuth token in Authorization, and no x-cursor-auth made up from it.
    expect(s.rig.seen.some((one) => one.auth)).toBe(true);
  }, 30_000);

  it("takes the header name from the server's words, not from a fixed one", async () => {
    const s = await signedIn();
    s.rig.noChallenge = "the X-Acme-Session header is required";
    const result = await s.test();
    expect(result).toMatchObject({
      status: "failed",
      requiredHeader: "x-acme-session",
    });
  }, 30_000);

  it("falls back to the plain refusal when the server names no header", async () => {
    const s = await signedIn();
    s.rig.noChallenge = "nope";
    const result = await s.test();
    expect(result.requiredHeader).toBeUndefined();
    expect(result.status).toBe("needs_login");
  }, 30_000);

  it("sends a header the user added next to the sign-in, and the SDK keeps both", async () => {
    const s = await signedIn();
    const value = "manual-credential-0123456789";
    const result = await s.test({ headers: { "x-cursor-auth": value } });
    expect(result.status).toBe("ok");
    const mcp = s.rig.seen.filter((one) => one.auth);
    expect(mcp.length).toBeGreaterThan(0);
    // Every request that carried the sign-in carried the header too, with its length (never printed).
    for (const one of mcp)
      expect(one.headers["x-cursor-auth"]).toBe(value.length);
    expect(JSON.stringify(result)).not.toContain(value);
  }, 30_000);

  describe("two layers: a Cursor header and the service's own sign-in", () => {
    it("the Cursor header goes to the server only, never to the OAuth server (token, refresh, metadata)", async () => {
      const s = await signedIn();
      const old = (await s.access())!;
      s.rig.dead.add(old); // forces a refresh against the OAuth server
      const result = await s.test({
        headers: { "x-cursor-auth": "Bearer jwt-SECRETVALUE-0123456789" },
        tokenHeader: { name: "x-cursor-token", format: "bearer" },
      });
      expect(result.status).toBe("ok");
      expect(s.auth.tokenRequests("refresh_token")).toBe(1);
      expect(s.rig.authHeaders.length).toBeGreaterThan(0);
      for (const names of s.rig.authHeaders) {
        expect(names).not.toContain("x-cursor-auth");
        expect(names).not.toContain("x-cursor-token");
      }
    }, 30_000);

    it("a request without the header, or with a bare value, is refused as missing; Bearer plus the sign-in passes", async () => {
      const s = await signedIn();
      s.rig.cursorLayer = true;
      const none = await s.test();
      expect(none.requiredHeader).toBe("x-cursor-auth");
      const bare = await s.test({
        headers: { "x-cursor-auth": "jwt-SECRETVALUE-0123456789" },
      });
      expect(bare.requiredHeader).toBe("x-cursor-auth");
      const good = await s.test({
        headers: { "x-cursor-auth": "Bearer jwt-SECRETVALUE-0123456789" },
      });
      expect(good.status).toBe("ok");
      for (const result of [none, bare, good])
        expect(JSON.stringify(result)).not.toContain("SECRETVALUE");
      // Both headers were on the request that passed.
      const last = s.rig.seen.filter((one) => one.auth).at(-1)!;
      expect(last.headers["x-cursor-auth"]).toBeGreaterThan(0);
    }, 30_000);
  });

  describe("the sign-in token in a header the user chose", () => {
    const NAME = "x-cursor-auth";
    const carried = (s: Awaited<ReturnType<typeof signedIn>>) =>
      s.rig.seen.filter((one) => one.auth).map((one) => one.values[NAME]);

    it("sends the current access token as it is, on every request that carries the sign-in", async () => {
      const s = await signedIn();
      const token = (await s.access())!;
      const result = await s.test({
        tokenHeader: { name: NAME, format: "raw" },
      });
      expect(result.status).toBe("ok");
      const values = carried(s);
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) expect(value).toBe(token);
      expect(JSON.stringify(result)).not.toContain(token);
    }, 30_000);

    it("sends Bearer <token> when asked for that format", async () => {
      const s = await signedIn();
      const token = (await s.access())!;
      const result = await s.test({
        tokenHeader: { name: NAME, format: "bearer" },
      });
      expect(result.status).toBe("ok");
      for (const value of carried(s)) expect(value).toBe(`Bearer ${token}`);
    }, 30_000);

    it("never overwrites a header the user configured under the same name (a Cursor credential)", async () => {
      const s = await signedIn();
      const token = (await s.access())!;
      const credential = "Bearer cursor-credential-0123456789";
      const result = await s.test({
        headers: { [NAME]: credential },
        tokenHeader: { name: NAME, format: "bearer" },
      });
      expect(result.status).toBe("ok");
      const values = carried(s);
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) {
        expect(value).toBe(credential);
        expect(value).not.toBe(`Bearer ${token}`);
      }
    }, 30_000);

    it("uses the new token after a refresh, not the one it started with", async () => {
      const s = await signedIn();
      const old = (await s.access())!;
      s.rig.dead.add(old);
      const result = await s.test({
        tokenHeader: { name: NAME, format: "raw" },
      });
      expect(result.status).toBe("ok");
      expect(s.auth.tokenRequests("refresh_token")).toBe(1);
      const fresh = (await s.access())!;
      expect(fresh).not.toBe(old);
      const values = carried(s);
      expect(values).toContain(old);
      // Once the refresh is done, every later request carries the new token in the header too.
      expect(values.at(-1)).toBe(fresh);
      expect(values.at(-1)).not.toBe(old);
    }, 30_000);

    it("sends nothing when no header is chosen", async () => {
      const s = await signedIn();
      const result = await s.test();
      expect(result.status).toBe("ok");
      for (const one of s.rig.seen)
        expect(Object.keys(one.headers)).not.toContain(NAME);
    }, 30_000);

    it("keeps the value out of what a refusal says", async () => {
      const s = await signedIn();
      const token = (await s.access())!;
      s.rig.noChallenge = (carried) => `echo ${carried}`;
      const result = await s.test({
        tokenHeader: { name: NAME, format: "raw" },
      });
      expect(JSON.stringify(result)).not.toContain(token);
    }, 30_000);
  });
});
