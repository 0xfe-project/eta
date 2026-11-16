/**
 * OAuth for the MCP servers of a daemon's sessions.
 *
 * Credentials live on the primary, once per server URL, so one sign-in serves every agent on every
 * machine. A daemon keeps none: its OAuth provider reads and writes them with one call to the
 * primary each (`mcp.credential`), so a token the SDK refreshes mid-session is saved where the next
 * session, anywhere, finds it. The daemon never signs anyone in: the browser, the callback and the
 * login are the primary's. A server without credentials reports that it needs a login, and the
 * next call to it asks the primary again, so a login there reaches a session already open.
 *
 * The primary checks every call with `parseCredentialCall`, the same rules the daemon sends by.
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
 * The key a server's credentials are stored under: a hash of its URL alone, so the same server has
 * the same credentials for every agent and every machine, and a machine can only name the
 * credentials of a server whose URL it knows. The fragment is not part of the server's identity.
 */
export function mcpServerKey(url: string): string {
  const identity = new URL(url);
  identity.hash = "";
  return createHash("sha256").update(identity.href).digest("hex");
}

/** What a daemon may read, write or forget on the primary: never a login's PKCE verifier. */
export const RELAYED_KINDS: readonly McpRelayedKind[] = [
  "tokens",
  "clientInformation",
  "discoveryState",
];

const isRelayed = (kind: unknown): kind is McpRelayedKind =>
  (RELAYED_KINDS as readonly unknown[]).includes(kind);

/** The shape of `mcpServerKey`: a SHA-256, in lowercase hex. */
const SERVER_KEY = /^[0-9a-f]{64}$/;

/**
 * A daemon's `mcp.credential` call, checked: an operation, a server key shaped like a URL's hash,
 * a relayed kind, and for `set` a JSON object. Anything else throws, and nothing is read or written.
 */
export function parseCredentialCall(raw: unknown): McpCredentialCall {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("mcp.credential takes an object");
  const { op, serverKey, kind, value } = raw as Record<string, unknown>;
  if (typeof serverKey !== "string" || !SERVER_KEY.test(serverKey))
    throw new Error("mcp.credential: serverKey is not a server URL's hash");
  if (!isRelayed(kind))
    throw new Error(`mcp.credential: ${String(kind)} stays on the primary`);
  if (op === "get" || op === "delete") return { op, serverKey, kind };
  if (op === "set") {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("mcp.credential: a value is a JSON object");
    return { op, serverKey, kind, value };
  }
  throw new Error(`mcp.credential: no such operation ${String(op)}`);
}

const TIMEOUT_MS = 15_000;

/**
 * A credential store whose rows are on the primary. The PKCE verifier only matters to a login,
 * which a daemon never starts: it reads as nothing and is never forgotten here, and saving one is
 * refused.
 */
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
  const local = (kind: CredentialKind): kind is McpRelayedKind =>
    isRelayed(kind);
  return {
    get: async (serverKey, kind) => {
      if (!local(kind)) return undefined;
      const value = await relay({ op: "get", serverKey, kind });
      return (value ?? undefined) as never;
    },
    set: async (serverKey, kind, value) => {
      if (!local(kind)) throw new Error(`${kind} stays on the primary`);
      await relay({ op: "set", serverKey, kind, value });
    },
    delete: async (serverKey, kind) => {
      if (!local(kind)) return;
      await relay({ op: "delete", serverKey, kind });
    },
  };
}

/** The `authProviderFor` of a daemon: connect mode, over the relay. */
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
