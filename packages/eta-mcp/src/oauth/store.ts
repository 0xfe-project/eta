// Credential storage contract for MCP OAuth. The host implements it (SQLite in eta).
// Shape follows opencode's McpOAuth.Store (packages/core/src/mcp/oauth.ts, MIT, (c) 2025
// opencode), keyed per server and extended with the SDK's discovery state.
import type {
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";

/** What is kept per MCP server. */
export interface CredentialRecord {
  tokens: StoredOAuthTokens;
  clientInformation: StoredOAuthClientInformation;
  codeVerifier: string;
  discoveryState: OAuthDiscoveryState;
}

export type CredentialKind = keyof CredentialRecord;

/**
 * `serverKey` names one MCP server (and whatever scope the host isolates credentials by).
 * Implementations should treat values as opaque JSON.
 */
export interface CredentialStore {
  get: <K extends CredentialKind>(
    serverKey: string,
    kind: K,
  ) => Promise<CredentialRecord[K] | undefined>;
  set: <K extends CredentialKind>(
    serverKey: string,
    kind: K,
    value: CredentialRecord[K],
  ) => Promise<void>;
  delete: (serverKey: string, kind: CredentialKind) => Promise<void>;
}
