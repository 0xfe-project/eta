import type { FetchLike } from "@modelcontextprotocol/client";
import type { CredentialKind, CredentialStore } from "./store";
// Login flow for a server-side host: the browser comes back to the host's own HTTP route (or the
// user pastes the redirect URL when the host is headless), never to a loopback listener in here.
// Ported in spirit from pi-mcp-adapter's mcp-auth-flow.ts (MIT, (c) 2026 Nico Bailon):
// parseAuthorizationRedirectInput's redirect-URL handling and state check. The begin/complete split,
// pending logins and the discovery challenge probe follow opencode's `authorize`
// (packages/core/src/mcp/oauth.ts, MIT, (c) 2025 opencode), minus its callback HTTP server.
import {
  auth,
  extractWWWAuthenticateParams,
  LATEST_PROTOCOL_VERSION,
} from "@modelcontextprotocol/client";
import { createOAuthProvider } from "./provider";

export type LoginErrorCode =
  | "unknown_pending"
  | "expired"
  | "state_mismatch"
  | "denied"
  | "invalid_callback"
  | "exchange_failed"
  | "no_authorization_url";

export class LoginError extends Error {
  readonly code: LoginErrorCode;
  constructor(
    code: LoginErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LoginError";
    this.code = code;
  }
}

export interface OAuthLoginsOptions {
  store: CredentialStore;
  /** The host's callback route, e.g. `https://eta.example.com/api/mcp/oauth/callback`. */
  redirectUrl: string;
  clientMetadataUrl?: string;
  clientName?: string;
  /** Use createRefreshDedupingFetch(...) here so logins and connections share refresh requests. */
  fetchFn?: FetchLike;
  /** How long a login may stay pending. Default 10 minutes. */
  ttlMs?: number;
  now?: () => number;
}

export interface BeginLoginInput {
  serverKey: string;
  serverUrl: string;
  scope?: string;
  /** Extra headers for the unauthenticated probe request (the server's configured headers). */
  headers?: Record<string, string>;
}

export interface PendingLogin {
  /** Equal to the OAuth `state`, so a callback route can find the login from the redirect URL alone. */
  pendingId: string;
  serverKey: string;
  authorizationUrl: string;
  expiresAt: number;
}

export interface OAuthLogins {
  beginLogin: (input: BeginLoginInput) => Promise<PendingLogin>;
  /** `callbackUrl` is the full redirect URL, as received by the host or pasted by the user. */
  completeLogin: (
    pendingId: string,
    callbackUrl: string,
  ) => Promise<{ serverKey: string }>;
  cancelLogin: (pendingId: string) => Promise<void>;
  /** Unexpired pending logins. */
  pending: () => PendingLogin[];
  /** Forget everything stored for the server and cancel its pending login. */
  logout: (serverKey: string) => Promise<void>;
}

interface Pending extends PendingLogin {
  state: string;
  serverUrl: string;
  scope: string | undefined;
  resourceMetadataUrl: URL | undefined;
  provider: ReturnType<typeof createOAuthProvider>;
}

const KINDS: CredentialKind[] = [
  "tokens",
  "clientInformation",
  "codeVerifier",
  "discoveryState",
];

export function createOAuthLogins(options: OAuthLoginsOptions): OAuthLogins {
  const { store, redirectUrl } = options;
  const fetchFn = options.fetchFn ?? fetch;
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const now = options.now ?? Date.now;
  const logins = new Map<string, Pending>();

  const discard = async (login: Pending) => {
    logins.delete(login.pendingId);
    // The verifier belongs to the latest login for the server only.
    if (
      ![...logins.values()].some((other) => other.serverKey === login.serverKey)
    ) {
      await store.delete(login.serverKey, "codeVerifier");
    }
  };

  const sweep = async () => {
    for (const login of [...logins.values()]) {
      if (login.expiresAt <= now()) await discard(login);
    }
  };

  // The 401 names where resource metadata lives and which scopes the server wants; without it
  // discovery can only guess the well-known path.
  const probe = async (input: BeginLoginInput) => {
    try {
      const response = await fetchFn(input.serverUrl, {
        method: "POST",
        headers: {
          ...input.headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: options.clientName ?? "eta", version: "0" },
          },
        }),
        signal: AbortSignal.timeout(5000),
      });
      return extractWWWAuthenticateParams(response);
    } catch {
      return { resourceMetadataUrl: undefined, scope: undefined };
    }
  };

  const beginLogin: OAuthLogins["beginLogin"] = async (input) => {
    await sweep();
    for (const previous of [...logins.values()]) {
      if (previous.serverKey === input.serverKey) await discard(previous);
    }
    // A login is an explicit "start over": drop tokens so the SDK does not just refresh them, and
    // rediscover the authorization server. A client registered for another redirect URL is unusable.
    for (const kind of ["tokens", "codeVerifier", "discoveryState"] as const)
      await store.delete(input.serverKey, kind);
    const client = await store.get(input.serverKey, "clientInformation");
    if (
      client &&
      "redirect_uris" in client &&
      !client.redirect_uris.includes(redirectUrl)
    ) {
      await store.delete(input.serverKey, "clientInformation");
    }

    const state = crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");
    const challenge = await probe(input);
    const scope = input.scope ?? challenge.scope;
    let authorizationUrl: URL | undefined;
    const provider = createOAuthProvider({
      serverKey: input.serverKey,
      serverUrl: input.serverUrl,
      store,
      redirectUrl,
      state: () => state,
      onAuthorizationUrl: (url) => {
        authorizationUrl = url;
      },
      ...(options.clientMetadataUrl
        ? { clientMetadataUrl: options.clientMetadataUrl }
        : {}),
      ...(options.clientName ? { clientName: options.clientName } : {}),
    });
    await auth(provider, {
      serverUrl: input.serverUrl,
      fetchFn,
      ...(scope ? { scope } : {}),
      ...(challenge.resourceMetadataUrl
        ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
        : {}),
    });
    if (!authorizationUrl) {
      throw new LoginError(
        "no_authorization_url",
        `MCP server "${input.serverUrl}" did not provide an authorization URL`,
      );
    }
    const login: Pending = {
      pendingId: state,
      state,
      serverKey: input.serverKey,
      serverUrl: input.serverUrl,
      scope,
      resourceMetadataUrl: challenge.resourceMetadataUrl,
      authorizationUrl: authorizationUrl.toString(),
      expiresAt: now() + ttlMs,
      provider,
    };
    logins.set(state, login);
    return toPublic(login);
  };

  const completeLogin: OAuthLogins["completeLogin"] = async (
    pendingId,
    callbackUrl,
  ) => {
    const login = logins.get(pendingId);
    if (!login)
      throw new LoginError(
        "unknown_pending",
        "No pending login with that id (it may have been cancelled, replaced or already completed)",
      );
    if (login.expiresAt <= now()) {
      await discard(login);
      throw new LoginError("expired", "The login expired; start it again");
    }
    let url: URL;
    try {
      url = new URL(callbackUrl.trim());
    } catch (error) {
      throw new LoginError(
        "invalid_callback",
        "Expected the full redirect URL, including its query string",
        { cause: error },
      );
    }
    const params = url.searchParams;
    const returned = params.get("state");
    // Checked before anything else so a forged callback cannot cancel or complete the login.
    if (returned !== login.state) {
      throw new LoginError(
        "state_mismatch",
        returned === null
          ? "OAuth state missing from the redirect URL"
          : "OAuth state mismatch - potential CSRF attack",
      );
    }
    const denied = params.get("error");
    if (denied) {
      await discard(login);
      const description = params.get("error_description");
      throw new LoginError(
        "denied",
        description ? `${denied}: ${description}` : denied,
      );
    }
    const code = params.get("code");
    if (!code)
      throw new LoginError(
        "invalid_callback",
        "Could not find an OAuth authorization code in the redirect URL",
      );

    // The code is single use: take the login before the first await.
    logins.delete(pendingId);
    try {
      const iss = params.get("iss");
      await auth(login.provider, {
        serverUrl: login.serverUrl,
        authorizationCode: code,
        fetchFn,
        ...(iss !== null ? { iss } : {}),
        ...(login.scope ? { scope: login.scope } : {}),
        ...(login.resourceMetadataUrl
          ? { resourceMetadataUrl: login.resourceMetadataUrl }
          : {}),
      });
      if (!(await store.get(login.serverKey, "tokens"))) {
        throw new Error(
          `MCP server "${login.serverUrl}" did not return OAuth tokens`,
        );
      }
    } catch (error) {
      throw new LoginError(
        "exchange_failed",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    } finally {
      await store.delete(login.serverKey, "codeVerifier");
    }
    return { serverKey: login.serverKey };
  };

  return {
    beginLogin,
    completeLogin,
    cancelLogin: async (pendingId) => {
      const login = logins.get(pendingId);
      if (login) await discard(login);
    },
    pending: () =>
      [...logins.values()]
        .filter((login) => login.expiresAt > now())
        .map(toPublic),
    logout: async (serverKey) => {
      for (const login of [...logins.values()]) {
        if (login.serverKey === serverKey) logins.delete(login.pendingId);
      }
      for (const kind of KINDS) await store.delete(serverKey, kind);
    },
  };
}

function toPublic(login: Pending): PendingLogin {
  return {
    pendingId: login.pendingId,
    serverKey: login.serverKey,
    authorizationUrl: login.authorizationUrl,
    expiresAt: login.expiresAt,
  };
}
