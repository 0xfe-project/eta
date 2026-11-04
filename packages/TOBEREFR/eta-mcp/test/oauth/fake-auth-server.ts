import type { FetchLike } from "@modelcontextprotocol/client";
// An in-process MCP server + authorization server behind a FetchLike, so the OAuth tests run the
// SDK's real discovery, registration, PKCE and token code without a network.
import { createHash } from "node:crypto";

export const MCP_URL = "https://mcp.test/mcp";
export const ISSUER = "https://auth.test";
export const REDIRECT_URL = "https://eta.test/api/mcp/oauth/callback";
export const CIMD_URL = "https://eta.test/oauth/client.json";

export interface FakeAuthServerOptions {
  /** Advertise client_id_metadata_document_supported. */
  cimd?: boolean;
  /** Offer dynamic client registration. Default true. */
  registration?: boolean;
  /** Make the token endpoint wait, so concurrent requests overlap. */
  tokenDelayMs?: number;
}

interface Grant {
  challenge: string;
  clientId: string;
  redirectUri: string;
  resource: string | null;
}

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export function createFakeAuthServer(options: FakeAuthServerOptions = {}) {
  const registration = options.registration ?? true;
  const codes = new Map<string, Grant>();
  const clients = new Set<string>();
  let refreshToken = "";
  let counter = 0;
  const requests: { method: string; url: string; params?: URLSearchParams }[] =
    [];
  const count = (grant: string) =>
    requests.filter((request) => request.params?.get("grant_type") === grant)
      .length;

  const issue = () => {
    counter += 1;
    refreshToken = `refresh-${counter}`;
    return {
      access_token: `access-${counter}`,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
    };
  };

  const fetchFn: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body;
    const params =
      body instanceof URLSearchParams
        ? body
        : typeof body === "string" && !body.startsWith("{")
          ? new URLSearchParams(body)
          : undefined;
    requests.push({
      method,
      url: url.toString(),
      ...(params ? { params } : {}),
    });

    if (url.origin === "https://mcp.test") {
      if (
        url.pathname === "/.well-known/oauth-protected-resource" ||
        url.pathname === "/.well-known/oauth-protected-resource/mcp"
      ) {
        return json({
          resource: MCP_URL,
          authorization_servers: [ISSUER],
          scopes_supported: ["read"],
        });
      }
      if (url.pathname === "/mcp") {
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource", scope="read"`,
          },
        });
      }
      return new Response("not found", { status: 404 });
    }

    if (url.origin !== ISSUER)
      return new Response("not found", { status: 404 });
    if (
      url.pathname.startsWith("/.well-known/oauth-authorization-server") ||
      url.pathname.startsWith("/.well-known/openid-configuration")
    ) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        ...(registration
          ? { registration_endpoint: `${ISSUER}/register` }
          : {}),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        ...(options.cimd
          ? { client_id_metadata_document_supported: true }
          : {}),
      });
    }
    if (url.pathname === "/register" && method === "POST") {
      const metadata = JSON.parse(String(body));
      const clientId = `client-${clients.size + 1}`;
      clients.add(clientId);
      return json({ ...metadata, client_id: clientId }, 201);
    }
    if (url.pathname === "/token" && method === "POST") {
      if (options.tokenDelayMs)
        await new Promise((resolve) =>
          setTimeout(resolve, options.tokenDelayMs),
        );
      const grant = params?.get("grant_type");
      if (grant === "authorization_code") {
        const code = params?.get("code") ?? "";
        const issued = codes.get(code);
        codes.delete(code);
        if (!issued)
          return json(
            { error: "invalid_grant", error_description: "unknown code" },
            400,
          );
        const verifier = params?.get("code_verifier") ?? "";
        const challenge = createHash("sha256")
          .update(verifier)
          .digest("base64url");
        if (challenge !== issued.challenge)
          return json(
            { error: "invalid_grant", error_description: "PKCE mismatch" },
            400,
          );
        if (params?.get("client_id") !== issued.clientId)
          return json({ error: "invalid_client" }, 401);
        if (params?.get("redirect_uri") !== issued.redirectUri)
          return json(
            { error: "invalid_grant", error_description: "redirect_uri" },
            400,
          );
        if (params?.get("resource") !== issued.resource)
          return json({ error: "invalid_target" }, 400);
        return json(issue());
      }
      if (grant === "refresh_token") {
        if (params?.get("refresh_token") !== refreshToken) {
          return json(
            {
              error: "invalid_grant",
              error_description: "refresh token is not current",
            },
            400,
          );
        }
        return json(issue());
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }
    return new Response("not found", { status: 404 });
  };

  return {
    fetch: fetchFn,
    requests,
    /** Number of token requests of this grant type that reached the server. */
    tokenRequests: count,
    registrations: () =>
      requests.filter((request) => request.url === `${ISSUER}/register`).length,
    /** The refresh token the server currently accepts. */
    currentRefreshToken: () => refreshToken,
    /** Make every refresh token invalid, as when the user revoked access. */
    revokeRefreshTokens: () => {
      refreshToken = "revoked";
    },
    /** Play the browser: approve an authorization URL and return the redirect URL it ends up at. */
    approve: (authorizationUrl: string) => {
      const url = new URL(authorizationUrl);
      if (url.origin + url.pathname !== `${ISSUER}/authorize`)
        throw new Error(`unexpected authorization URL ${authorizationUrl}`);
      if (url.searchParams.get("response_type") !== "code")
        throw new Error("response_type must be code");
      if (url.searchParams.get("code_challenge_method") !== "S256")
        throw new Error("PKCE S256 is required");
      const clientId = url.searchParams.get("client_id") ?? "";
      if (!clients.has(clientId) && clientId !== CIMD_URL)
        throw new Error(`unknown client ${clientId}`);
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const code = `code-${codes.size + 1}-${Math.random().toString(36).slice(2)}`;
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        clientId,
        redirectUri,
        resource: url.searchParams.get("resource"),
      });
      const redirect = new URL(redirectUri);
      redirect.searchParams.set("code", code);
      const state = url.searchParams.get("state");
      if (state) redirect.searchParams.set("state", state);
      return redirect.toString();
    },
  };
}
