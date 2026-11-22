import type { FakeAuthServerOptions } from "./fake-auth-server";
import { auth, UnauthorizedError } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOAuthLogins,
  createOAuthProvider,
  createRefreshDedupingFetch,
  LoginError,
} from "../../src/oauth/index.js";
import {
  CIMD_URL,
  createFakeAuthServer,
  MCP_URL,
  REDIRECT_URL,
} from "./fake-auth-server";
import { createMemoryCredentialStore } from "./memory-store";

const KEY = "persona-1/github";

function setup(
  serverOptions: FakeAuthServerOptions = {},
  loginOptions: { clientMetadataUrl?: string; ttlMs?: number } = {},
) {
  const server = createFakeAuthServer(serverOptions);
  const store = createMemoryCredentialStore();
  const fetchFn = createRefreshDedupingFetch(server.fetch);
  let clock = 1_000_000;
  const logins = createOAuthLogins({
    store,
    redirectUrl: REDIRECT_URL,
    fetchFn,
    now: () => clock,
    ...loginOptions,
  });
  const connect = () =>
    createOAuthProvider({
      serverKey: KEY,
      serverUrl: MCP_URL,
      store,
      redirectUrl: REDIRECT_URL,
    });
  const signIn = async () => {
    const pending = await logins.beginLogin({
      serverKey: KEY,
      serverUrl: MCP_URL,
    });
    await logins.completeLogin(
      pending.pendingId,
      server.approve(pending.authorizationUrl),
    );
    return pending;
  };
  return {
    server,
    store,
    fetchFn,
    logins,
    connect,
    signIn,
    advance: (ms: number) => (clock += ms),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("login", () => {
  it("discovers, registers dynamically, uses PKCE and stores tokens", async () => {
    const { server, store, logins } = setup();
    const pending = await logins.beginLogin({
      serverKey: KEY,
      serverUrl: MCP_URL,
    });

    const url = new URL(pending.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://auth.test/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URL);
    expect(url.searchParams.get("state")).toBe(pending.pendingId);
    // The scope from the 401 challenge reaches the authorization request.
    expect(url.searchParams.get("scope")).toBe("read");
    expect(server.registrations()).toBe(1);
    expect(await store.get(KEY, "codeVerifier")).toBeTruthy();
    expect(await store.get(KEY, "discoveryState")).toMatchObject({
      authorizationServerUrl: "https://auth.test",
    });

    const result = await logins.completeLogin(
      pending.pendingId,
      server.approve(pending.authorizationUrl),
    );
    expect(result).toEqual({ serverKey: KEY });
    expect(await store.get(KEY, "tokens")).toMatchObject({
      access_token: "access-1",
      refresh_token: "refresh-1",
    });
    expect(await store.get(KEY, "codeVerifier")).toBeUndefined();
    expect(logins.pending()).toEqual([]);
  });

  it("uses the client metadata URL as client_id when the server advertises CIMD", async () => {
    const { server, store, logins } = setup(
      { cimd: true },
      { clientMetadataUrl: CIMD_URL },
    );
    const pending = await logins.beginLogin({
      serverKey: KEY,
      serverUrl: MCP_URL,
    });

    expect(
      new URL(pending.authorizationUrl).searchParams.get("client_id"),
    ).toBe(CIMD_URL);
    expect(server.registrations()).toBe(0);
    await logins.completeLogin(
      pending.pendingId,
      server.approve(pending.authorizationUrl),
    );
    expect(await store.get(KEY, "tokens")).toBeTruthy();
  });

  it("registers dynamically when CIMD is configured but not advertised", async () => {
    const { server, logins } = setup(
      { cimd: false },
      { clientMetadataUrl: CIMD_URL },
    );
    const pending = await logins.beginLogin({
      serverKey: KEY,
      serverUrl: MCP_URL,
    });

    expect(
      new URL(pending.authorizationUrl).searchParams.get("client_id"),
    ).toBe("client-1");
    expect(server.registrations()).toBe(1);
  });

  it("registers dynamically when the server advertises CIMD but none is configured", async () => {
    const { server, logins } = setup({ cimd: true });
    await logins.beginLogin({ serverKey: KEY, serverUrl: MCP_URL });
    expect(server.registrations()).toBe(1);
  });

  it("rejects a redirect with the wrong state and keeps the login pending", async () => {
    const { server, store, logins } = setup();
    const pending = await logins.beginLogin({
      serverKey: KEY,
      serverUrl: MCP_URL,
    });
    const callback = new URL(server.approve(pending.authorizationUrl));

    callback.searchParams.set("state", "forged");
    await expect(
      logins.completeLogin(pending.pendingId, callback.toString()),
    ).rejects.toMatchObject({ code: "state_mismatch" });
    callback.searchParams.delete("state");
    await expect(
      logins.completeLogin(pending.pendingId, callback.toString()),
    ).rejects.toMatchObject({ code: "state_mismatch" });
    expect(await store.get(KEY, "tokens")).toBeUndefined();
    expect(server.tokenRequests("authorization_code")).toBe(0);

    callback.searchParams.set("state", pending.pendingId);
    await logins.completeLogin(pending.pendingId, callback.toString());
    expect(await store.get(KEY, "tokens")).toBeTruthy();
  });

  it("completes only once", async () => {
    const { server, logins } = setup();
    const pending = await logins.beginLogin({
      serverKey: KEY,
      serverUrl: MCP_URL,
    });
    const callback = server.approve(pending.authorizationUrl);
    await logins.completeLogin(pending.pendingId, callback);
    await expect(
      logins.completeLogin(pending.pendingId, callback),
    ).rejects.toMatchObject({ code: "unknown_pending" });
  });

  it("reports a denied authorization and ends the login", async () => {
    const { logins } = setup();
    const pending = await logins.beginLogin({
      serverKey: KEY,
      serverUrl: MCP_URL,
    });
    const callback = `${REDIRECT_URL}?error=access_denied&error_description=nope&state=${pending.pendingId}`;
    await expect(
      logins.completeLogin(pending.pendingId, callback),
    ).rejects.toMatchObject({ code: "denied", message: "access_denied: nope" });
    expect(logins.pending()).toEqual([]);
  });

  it("rejects input that is not a redirect URL", async () => {
    const { logins } = setup();
    const pending = await logins.beginLogin({
      serverKey: KEY,
      serverUrl: MCP_URL,
    });
    await expect(
      logins.completeLogin(pending.pendingId, "just-a-code"),
    ).rejects.toMatchObject({ code: "invalid_callback" });
    await expect(
      logins.completeLogin(
        pending.pendingId,
        `${REDIRECT_URL}?state=${pending.pendingId}`,
      ),
    ).rejects.toMatchObject({
      code: "invalid_callback",
    });
  });

  it("surfaces a failed code exchange", async () => {
    const { server, store, logins } = setup();
    const pending = await logins.beginLogin({
      serverKey: KEY,
      serverUrl: MCP_URL,
    });
    const callback = new URL(server.approve(pending.authorizationUrl));
    callback.searchParams.set("code", "bogus");
    await expect(
      logins.completeLogin(pending.pendingId, callback.toString()),
    ).rejects.toBeInstanceOf(LoginError);
    expect(await store.get(KEY, "tokens")).toBeUndefined();
    expect(await store.get(KEY, "codeVerifier")).toBeUndefined();
  });

  it("expires pending logins", async () => {
    const { server, store, logins, advance } = setup({}, { ttlMs: 60_000 });
    const pending = await logins.beginLogin({
      serverKey: KEY,
      serverUrl: MCP_URL,
    });
    const callback = server.approve(pending.authorizationUrl);
    expect(logins.pending()).toHaveLength(1);

    advance(60_001);
    expect(logins.pending()).toEqual([]);
    await expect(
      logins.completeLogin(pending.pendingId, callback),
    ).rejects.toMatchObject({ code: "expired" });
    expect(await store.get(KEY, "codeVerifier")).toBeUndefined();
    await expect(
      logins.completeLogin(pending.pendingId, callback),
    ).rejects.toMatchObject({ code: "unknown_pending" });
  });

  it("cancels a pending login", async () => {
    const { server, store, logins } = setup();
    const pending = await logins.beginLogin({
      serverKey: KEY,
      serverUrl: MCP_URL,
    });
    const callback = server.approve(pending.authorizationUrl);
    await logins.cancelLogin(pending.pendingId);
    expect(await store.get(KEY, "codeVerifier")).toBeUndefined();
    await expect(
      logins.completeLogin(pending.pendingId, callback),
    ).rejects.toMatchObject({ code: "unknown_pending" });
  });

  it("replaces an earlier pending login for the same server", async () => {
    const { server, logins } = setup();
    const first = await logins.beginLogin({
      serverKey: KEY,
      serverUrl: MCP_URL,
    });
    const second = await logins.beginLogin({
      serverKey: KEY,
      serverUrl: MCP_URL,
    });
    expect(logins.pending().map((login) => login.pendingId)).toEqual([
      second.pendingId,
    ]);
    await expect(
      logins.completeLogin(
        first.pendingId,
        server.approve(first.authorizationUrl),
      ),
    ).rejects.toMatchObject({
      code: "unknown_pending",
    });
    await logins.completeLogin(
      second.pendingId,
      server.approve(second.authorizationUrl),
    );
  });

  it("logout clears every stored credential and pending login", async () => {
    const { store, logins, signIn } = setup();
    await signIn();
    const pending = await logins.beginLogin({
      serverKey: KEY,
      serverUrl: MCP_URL,
    });
    await logins.logout(KEY);
    for (const kind of [
      "tokens",
      "clientInformation",
      "codeVerifier",
      "discoveryState",
    ] as const) {
      expect(await store.get(KEY, kind)).toBeUndefined();
    }
    expect(logins.pending()).toEqual([]);
    await expect(
      logins.completeLogin(pending.pendingId, REDIRECT_URL),
    ).rejects.toMatchObject({ code: "unknown_pending" });
  });
});

describe("connect", () => {
  it("is authorized with stored tokens and needs no redirect", async () => {
    const { connect, signIn, fetchFn, server } = setup();
    await signIn();
    expect(await auth(connect(), { serverUrl: MCP_URL, fetchFn })).toBe(
      "AUTHORIZED",
    );
    expect(server.tokenRequests("refresh_token")).toBe(1);
  });

  it("needs login when nothing is stored, without registering a client", async () => {
    const { connect, fetchFn, server } = setup();
    await expect(
      auth(connect(), { serverUrl: MCP_URL, fetchFn }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(server.registrations()).toBe(0);
  });

  it("refreshes and saves the rotated tokens", async () => {
    const { connect, signIn, fetchFn, store } = setup();
    await signIn();
    await auth(connect(), { serverUrl: MCP_URL, fetchFn });
    expect(await store.get(KEY, "tokens")).toMatchObject({
      access_token: "access-2",
      refresh_token: "refresh-2",
    });
  });

  it("shares one refresh request between concurrent refreshes of the same token", async () => {
    const { connect, signIn, fetchFn, server, store } = setup({
      tokenDelayMs: 20,
    });
    await signIn();
    const results = await Promise.all([
      auth(connect(), { serverUrl: MCP_URL, fetchFn }),
      auth(connect(), { serverUrl: MCP_URL, fetchFn }),
      auth(connect(), { serverUrl: MCP_URL, fetchFn }),
    ]);
    expect(results).toEqual(["AUTHORIZED", "AUTHORIZED", "AUTHORIZED"]);
    expect(server.tokenRequests("refresh_token")).toBe(1);
    expect(await store.get(KEY, "tokens")).toMatchObject({
      refresh_token: "refresh-2",
    });
  });

  it("sends duplicate refreshes without the wrapper, and the rotation guard keeps the newer tokens", async () => {
    const { connect, signIn, server, store } = setup({ tokenDelayMs: 20 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await signIn();
    const outcomes = await Promise.all([
      auth(connect(), { serverUrl: MCP_URL, fetchFn: server.fetch }),
      auth(connect(), { serverUrl: MCP_URL, fetchFn: server.fetch }),
    ]);
    expect(outcomes).toEqual(["AUTHORIZED", "AUTHORIZED"]);
    expect(server.tokenRequests("refresh_token")).toBeGreaterThan(1);
    expect(await store.get(KEY, "tokens")).toBeTruthy();
  });

  it("needs login again when the refresh token was revoked, and drops the tokens", async () => {
    const { connect, signIn, fetchFn, server, store } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await signIn();
    server.revokeRefreshTokens();
    await expect(
      auth(connect(), { serverUrl: MCP_URL, fetchFn }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(await store.get(KEY, "tokens")).toBeUndefined();
    // The registered client survives, so signing in again does not register another one.
    expect(await store.get(KEY, "clientInformation")).toBeTruthy();
  });

  it("does not drop tokens that another connection already rotated", async () => {
    const { signIn, store, server } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await signIn();
    const stale = createOAuthProvider({
      serverKey: KEY,
      serverUrl: MCP_URL,
      store,
      redirectUrl: REDIRECT_URL,
    });
    await stale.tokens();
    // Another connection rotates the token while this one is mid-refresh.
    await store.set(KEY, "tokens", {
      access_token: "newer",
      token_type: "Bearer",
      refresh_token: "refresh-newer",
    });
    await stale.invalidateCredentials?.("tokens");
    expect(await store.get(KEY, "tokens")).toMatchObject({
      refresh_token: "refresh-newer",
    });
    expect(server.tokenRequests("refresh_token")).toBe(0);
  });

  it("can sign in again after tokens were revoked", async () => {
    const { connect, signIn, fetchFn, server, store } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await signIn();
    server.revokeRefreshTokens();
    await expect(
      auth(connect(), { serverUrl: MCP_URL, fetchFn }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await signIn();
    expect(server.registrations()).toBe(1);
    expect(await store.get(KEY, "tokens")).toBeTruthy();
  });
});

describe("rFC 9207 issuer of a proxy whose sign-in is a real provider's", () => {
  const PROXY = "https://auth.test/dcr";
  const IDP = "https://idp.test";
  function proxied(issParameterSupported: boolean) {
    const server = createFakeAuthServer();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const fetchFn = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (
        url.origin === "https://mcp.test" &&
        url.pathname.startsWith("/.well-known/oauth-protected-resource")
      )
        return json({
          resource: MCP_URL,
          authorization_servers: [PROXY],
          scopes_supported: ["read"],
        });
      if (
        url.origin === "https://auth.test" &&
        url.pathname === "/.well-known/oauth-authorization-server/dcr"
      )
        return json({
          issuer: PROXY,
          authorization_endpoint: `${IDP}/o/auth`,
          token_endpoint: "https://auth.test/token",
          registration_endpoint: "https://auth.test/register",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          ...(issParameterSupported
            ? { authorization_response_iss_parameter_supported: true }
            : {}),
        });
      return await server.fetch(input as never, init as never);
    }) as never;
    const store = createMemoryCredentialStore();
    const logins = createOAuthLogins({
      store,
      redirectUrl: REDIRECT_URL,
      fetchFn,
    });
    const run = async (iss: string | null) => {
      const pending = await logins.beginLogin({
        serverKey: KEY,
        serverUrl: MCP_URL,
      });
      expect(new URL(pending.authorizationUrl).host).toBe("idp.test");
      const local = new URL(pending.authorizationUrl);
      local.host = "auth.test";
      local.pathname = "/authorize";
      const back = new URL(server.approve(local.toString()));
      if (iss !== null) back.searchParams.set("iss", iss);
      return await logins.completeLogin(pending.pendingId, back.toString());
    };
    return { store, run };
  }

  it("accepts the provider the user was sent to, once, with a note", async () => {
    const { store, run } = proxied(false);
    const result = await run(IDP);
    expect(result.note).toContain("idp.test");
    expect(await store.get(KEY, "tokens")).toBeTruthy();
  });

  it("still passes when iss is the metadata issuer, with no note", async () => {
    const { store, run } = proxied(false);
    const result = await run(PROXY);
    expect(result.note).toBeUndefined();
    expect(await store.get(KEY, "tokens")).toBeTruthy();
  });

  it("refuses an iss from a host eta did not send the user to (a real mix-up)", async () => {
    const { store, run } = proxied(false);
    await expect(run("https://evil.test")).rejects.toMatchObject({
      code: "exchange_failed",
    });
    expect(await store.get(KEY, "tokens")).toBeUndefined();
  });

  it("refuses the mismatch when the metadata promises iss", async () => {
    const { store, run } = proxied(true);
    await expect(run(IDP)).rejects.toMatchObject({ code: "exchange_failed" });
    expect(await store.get(KEY, "tokens")).toBeUndefined();
  });
});
