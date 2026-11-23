import type { FetchLike } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOAuthLogins } from "../../src/oauth/index.js";
import { createMemoryCredentialStore } from "./memory-store";

// The MCP server, its resource metadata and its client registration live on one origin (as
// Cursor's rest-mcp proxies do); the authorization and token endpoints are on another (Google).
const SERVER = "https://api.proxy.test";
const MCP_URL = `${SERVER}/rest-mcp/drive/mcp`;
const ISSUER = `${SERVER}/rest-mcp/drive/dcr`;
const PROVIDER = "https://accounts.provider.test";
const REDIRECT = "https://eta.test/api/mcp/oauth/callback";
const KEY = "persona-1/github";
const HEADER = "x-cursor-auth";
const VALUE = "Bearer test-session-value";

interface Seen {
  method: string;
  url: string;
  header: string | null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function world() {
  const seen: Seen[] = [];
  const codes = new Map<string, string>();
  const fetchFn: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    seen.push({
      method,
      url: url.toString(),
      header: new Headers(init?.headers).get(HEADER),
    });
    if (url.origin === SERVER) {
      if (url.pathname === "/rest-mcp/drive/mcp") {
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${SERVER}/.well-known/oauth-protected-resource/rest-mcp/drive/mcp"`,
          },
        });
      }
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
        return json({ resource: MCP_URL, authorization_servers: [ISSUER] });
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server"))
        return json({
          issuer: ISSUER,
          authorization_endpoint: `${PROVIDER}/authorize`,
          token_endpoint: `${PROVIDER}/token`,
          registration_endpoint: `${SERVER}/rest-mcp/drive/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      if (url.pathname === "/rest-mcp/drive/register" && method === "POST")
        return json({ ...JSON.parse(String(init?.body)), client_id: "client-1" }, 201);
      return new Response("not found", { status: 404 });
    }
    if (url.origin === PROVIDER && url.pathname === "/token") {
      const params = new URLSearchParams(String(init?.body));
      const issued = codes.get(params.get("code") ?? "");
      const challenge = createHash("sha256")
        .update(params.get("code_verifier") ?? "")
        .digest("base64url");
      if (issued !== challenge) return json({ error: "invalid_grant" }, 400);
      return json({
        access_token: "access-1",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "refresh-1",
      });
    }
    return new Response("not found", { status: 404 });
  };
  // The browser: approve the authorization URL, return the redirect with a code.
  const approve = (authorizationUrl: string) => {
    const url = new URL(authorizationUrl);
    const code = "code-1";
    codes.set(code, url.searchParams.get("code_challenge") ?? "");
    const back = new URL(url.searchParams.get("redirect_uri") ?? REDIRECT);
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    return back.toString();
  };
  return { seen, fetchFn, approve };
}

const ownOrigin = (one: Seen) => new URL(one.url).origin === SERVER;

describe("login with the headers configured for a server", () => {
  it("sends them with the metadata and registration requests to the server's own origin, and to no other origin", async () => {
    const w = world();
    const logins = createOAuthLogins({
      store: createMemoryCredentialStore(),
      redirectUrl: REDIRECT,
      fetchFn: w.fetchFn,
    });
    const pending = await logins.beginLogin({
      serverKey: KEY,
      serverUrl: MCP_URL,
      headers: { [HEADER]: VALUE },
    });
    await logins.completeLogin(pending.pendingId, w.approve(pending.authorizationUrl));

    const own = w.seen.filter(ownOrigin);
    const other = w.seen.filter((one) => !ownOrigin(one));
    // Metadata, registration and the first probe, each on the server's origin.
    expect(own.some((one) => one.url.includes("oauth-protected-resource"))).toBe(true);
    expect(own.some((one) => one.url.includes("oauth-authorization-server"))).toBe(true);
    expect(own.some((one) => one.url.endsWith("/register"))).toBe(true);
    for (const one of own) expect(one.header, one.url).toBe(VALUE);
    // The token request goes to the provider, which never sees the header.
    expect(other.some((one) => one.url.endsWith("/token"))).toBe(true);
    for (const one of other) expect(one.header, one.url).toBeNull();
  });

  it("leaves requests alone when no headers are configured", async () => {
    const w = world();
    const logins = createOAuthLogins({
      store: createMemoryCredentialStore(),
      redirectUrl: REDIRECT,
      fetchFn: w.fetchFn,
    });
    const pending = await logins.beginLogin({ serverKey: KEY, serverUrl: MCP_URL });
    await logins.completeLogin(pending.pendingId, w.approve(pending.authorizationUrl));
    for (const one of w.seen) expect(one.header, one.url).toBeNull();
  });
});
