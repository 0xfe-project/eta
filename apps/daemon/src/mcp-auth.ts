/**
 * OAuth for the MCP servers of a daemon's sessions.
 *
 * Credentials live on the primary, once per server URL, so one sign-in serves every agent on every
 * machine. A daemon keeps none: its OAuth provider reads and writes them with one call to the
 * primary (`mcp.credential`), so a token the SDK refreshes mid-session is saved where the next
 * session, anywhere, will find it. The daemon never signs anyone in: the browser, the callback and
 * the login are the primary's. A server that needs a login reports that it does.
 */
import type { McpCredentialCall, McpRelayedKind } from "@eta/client-contracts";
import type {
  AuthProviderFor,
  CredentialKind,
  CredentialStore,
} from "@eta/mcp";
import type { Peer } from "./link/peer";
import { createHash } from "node:crypto";
import { createOAuthProvider } from "@eta/mcp";

/**
 * The key a server's credentials are stored under: derived from its URL alone, so the same server
 * has the same credentials for every agent and every machine, and a machine can only name the
 * credentials of a server whose URL it knows. The fragment is not part of the server's identity.
 */
export function mcpServerKey(url: string): string {
  const identity = new URL(url);
  identity.hash = "";
  return createHash("sha256").update(identity.href).digest("hex");
}

/** What a daemon may ask the primary to read, write or forget: never a login's PKCE verifier. */
export const RELAYED_KINDS: readonly McpRelayedKind[] = [
  "tokens",
  "clientInformation",
  "discoveryState",
];

const relayed = (kind: CredentialKind): McpRelayedKind => {
  if (!(RELAYED_KINDS as readonly string[]).includes(kind))
    throw new Error(`${kind} stays on the primary`);
  return kind as McpRelayedKind;
};

const TIMEOUT_MS = 15_000;

/** A credential store whose rows are on the primary. */
export function relayCredentialStore(
  peer: () => Peer | undefined,
): CredentialStore {
  const relay = async (request: McpCredentialCall): Promise<unknown> => {
    const link = peer();
    if (link === undefined || link.lost)
      throw new Error("the primary is not reachable");
    return await link.call("mcp.credential", request, {
      timeoutMs: TIMEOUT_MS,
    });
  };
  return {
    get: async (serverKey, kind) =>
      (await relay({ op: "get", serverKey, kind: relayed(kind) })) as never,
    set: async (serverKey, kind, value) => {
      await relay({ op: "set", serverKey, kind: relayed(kind), value });
    },
    delete: async (serverKey, kind) => {
      await relay({ op: "delete", serverKey, kind: relayed(kind) });
    },
  };
}

/** The `authProviderFor` of a daemon: connect mode over the relay. */
export function relayAuthProviderFor(
  peer: () => Peer | undefined,
): AuthProviderFor {
  const store = relayCredentialStore(peer);
  return (_name, context) =>
    createOAuthProvider({
      serverKey: mcpServerKey(context.url),
      serverUrl: context.url,
      store,
      // Connect mode never redirects; the callback is the primary's.
      redirectUrl: "http://127.0.0.1/mcp/oauth/callback",
    });
}
