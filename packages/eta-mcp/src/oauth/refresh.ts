import type {
  FetchLike,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { CredentialStore } from "./store";
import { auth } from "@modelcontextprotocol/client";
import { createOAuthProvider } from "./provider";

export interface RefreshStoredTokensOptions {
  serverKey: string;
  serverUrl: string;
  store: CredentialStore;
  /** Use the host's createRefreshDedupingFetch(...) so this and a connection share one refresh. */
  fetchFn?: FetchLike | undefined;
}

/**
 * Refresh a server's stored sign-in with its refresh token, save the result in the store and return
 * it. It never starts a login: undefined when there is no refresh token to use, and a refresh the
 * authorization server refuses (or one that would need the user) throws. As on a connection, the
 * SDK drops the stored tokens when the server answers `invalid_grant`.
 */
export async function refreshStoredTokens(
  options: RefreshStoredTokensOptions,
): Promise<StoredOAuthTokens | undefined> {
  const { serverKey, serverUrl, store, fetchFn } = options;
  if (!(await store.get(serverKey, "tokens"))?.refresh_token) return undefined;
  const provider = createOAuthProvider({
    serverKey,
    serverUrl,
    store,
    // Connect mode: no onAuthorizationUrl, so nothing here can redirect anyone.
    redirectUrl: "http://127.0.0.1/mcp/oauth/callback",
  });
  await auth(provider, { serverUrl, ...(fetchFn ? { fetchFn } : {}) });
  return await store.get(serverKey, "tokens");
}
