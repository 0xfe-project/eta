import type { OAuthClientProvider } from "@modelcontextprotocol/client";
import type { CredentialStore } from "./store";
// OAuthClientProvider backed by a CredentialStore.
// Adapted from opencode's `provider` (packages/core/src/mcp/oauth.ts, MIT, (c) 2025 opencode):
// connect mode that refuses to register or redirect, resource URL pinning, rotation-safe credential
// invalidation. Pi-mcp-adapter's mcp-oauth-provider.ts (MIT, (c) 2026 Nico Bailon) informed the
// shape of the persisted state; its keychain/file storage is replaced by CredentialStore.
import {
  checkResourceAllowed,
  UnauthorizedError,
  validateClientMetadataUrl,
} from "@modelcontextprotocol/client";

export interface OAuthProviderOptions {
  /** Key under which the store keeps this server's credentials. */
  serverKey: string;
  serverUrl: string;
  store: CredentialStore;
  /** Where the authorization server sends the browser back to (the host's callback route). */
  redirectUrl: string;
  /**
   * HTTPS URL of a Client ID Metadata Document. Used as the client_id, without registration, when
   * the authorization server advertises support; otherwise the client registers dynamically.
   */
  clientMetadataUrl?: string;
  /**
   * Receives the authorization URL when the SDK needs the user to sign in. Absent means connect
   * mode: the provider never registers a client or redirects, it throws UnauthorizedError so the
   * caller can report "needs login".
   */
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
  /** OAuth `state` for the authorization request. */
  state?: () => string;
  clientName?: string;
  scope?: string;
}

export function createOAuthProvider(
  options: OAuthProviderOptions,
): OAuthClientProvider {
  const { serverKey, serverUrl, store, redirectUrl, onAuthorizationUrl } =
    options;
  validateClientMetadataUrl(options.clientMetadataUrl);
  const needsLogin = (what: string) =>
    new UnauthorizedError(`MCP server "${serverUrl}" requires ${what}`);
  const identity = new URL(serverUrl);
  identity.hash = "";
  // Refresh tokens rotate and credentials are shared by every connection to this server: only drop
  // the tokens while they still hold the refresh token this provider last saw.
  let presented: string | undefined;
  return {
    redirectUrl,
    ...(options.clientMetadataUrl
      ? { clientMetadataUrl: options.clientMetadataUrl }
      : {}),
    ...(options.state ? { state: options.state } : {}),
    clientMetadata: {
      redirect_uris: [redirectUrl],
      client_name: options.clientName ?? "eta",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(options.scope ? { scope: options.scope } : {}),
    },
    discoveryState: () => store.get(serverKey, "discoveryState"),
    saveDiscoveryState: (state) =>
      store.set(serverKey, "discoveryState", state),
    // The SDK sends no RFC 8707 resource when the server publishes no resource metadata; some
    // authorization servers require one, so fall back to the configured URL.
    validateResourceURL: async (_serverUrl, resource) => {
      if (!resource) return identity;
      if (
        !checkResourceAllowed({
          requestedResource: identity,
          configuredResource: resource,
        })
      ) {
        throw new Error(
          `Protected resource ${resource} does not cover ${identity}`,
        );
      }
      const canonical = new URL(resource);
      // The query string is transport detail: keep the token bound to the configured URL so a
      // later refresh names the same resource the login did.
      if (
        canonical.origin === identity.origin &&
        canonical.pathname === identity.pathname
      )
        return identity;
      return canonical;
    },
    clientInformation: async () => {
      const stored = await store.get(serverKey, "clientInformation");
      if (!stored && !onAuthorizationUrl)
        throw needsLogin("a login before it can register a client");
      return stored;
    },
    saveClientInformation: (info) =>
      store.set(serverKey, "clientInformation", info),
    tokens: async () => {
      const tokens = await store.get(serverKey, "tokens");
      if (tokens) presented = tokens.refresh_token;
      return tokens;
    },
    saveTokens: async (tokens) => {
      presented = tokens.refresh_token;
      await store.set(serverKey, "tokens", tokens);
    },
    redirectToAuthorization: async (url) => {
      if (!onAuthorizationUrl) throw needsLogin("user authorization");
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(
          `MCP server "${serverUrl}" returned a ${url.protocol} authorization URL; only http and https are supported`,
        );
      }
      await onAuthorizationUrl(url);
    },
    saveCodeVerifier: (verifier) =>
      store.set(serverKey, "codeVerifier", verifier),
    codeVerifier: async () => {
      const verifier = await store.get(serverKey, "codeVerifier");
      if (!verifier)
        throw new Error("Missing PKCE code verifier for MCP OAuth flow");
      return verifier;
    },
    invalidateCredentials: async (scope) => {
      if (scope === "all") {
        for (const kind of [
          "tokens",
          "clientInformation",
          "codeVerifier",
          "discoveryState",
        ] as const) {
          await store.delete(serverKey, kind);
        }
        return;
      }
      if (scope === "tokens") {
        const current = await store.get(serverKey, "tokens");
        if (current && current.refresh_token !== presented) return;
        await store.delete(serverKey, "tokens");
        return;
      }
      await store.delete(
        serverKey,
        scope === "client"
          ? "clientInformation"
          : scope === "verifier"
            ? "codeVerifier"
            : "discoveryState",
      );
    },
  };
}
