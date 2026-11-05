/**
 * The `mcp` target: the MCP servers of every agent on the primary, as the settings page sees them.
 *
 * One section, `list`: for each agent and each source its servers come from (the user's
 * `~/.eta/mcp.json`, a project's `.mcp.json`), the server's name, how it is reached, whether it is
 * connected, how many tools it has, its last error and, for an OAuth server, whether anyone has
 * signed in. Credentials never leave the host: a sign-in is a URL to open and a redirect URL to
 * hand back.
 */

/** The actions this target has. One list, so the wire and the plugin cannot disagree. */
export const MCP_ACTIONS = [
  "connect",
  "reconnect",
  "login",
  "completeLogin",
  "logout",
] as const;
export type McpAction = (typeof MCP_ACTIONS)[number];

export type McpTransport = "stdio" | "http" | "sse";
export type McpLifecycleKind = "lazy" | "keep-alive" | "lazy-keep-alive";
export type McpConnectionState =
  | "connected"
  | "cached"
  | "not-connected"
  | "failed"
  | "needs-auth"
  | "disabled";
/** `none`: the server needs no sign-in; `needs_login`: it does, and nobody has (or it expired). */
export type McpAuthState = "none" | "signed_in" | "needs_login";

export interface McpServerView {
  agentId: string;
  agentName: string;
  server: string;
  /** Where the server is declared: `~/.eta/mcp.json` or `.mcp.json`. */
  source: string;
  transport: McpTransport;
  lifecycle: McpLifecycleKind;
  state: McpConnectionState;
  toolCount: number;
  /** The last error, while there is one. */
  error: string | null;
  auth: McpAuthState;
}

export interface McpSections {
  list: McpServerView[];
}

/** Names a server the way the list does: an agent's server of that name. */
export interface McpServerRef {
  agentId: string;
  server: string;
}

export interface McpArgs {
  /** Connect now, as a first call would (fetches the tool list). */
  connect: McpServerRef;
  /** Drop the connection and the failure memory, then connect again. */
  reconnect: McpServerRef;
  /**
   * Start a sign-in. `redirectOrigin` is the origin the browser reaches the host at
   * (`location.origin`); the host uses its configured public address instead when it has one.
   */
  login: McpServerRef & { redirectOrigin?: string };
  /** Finish a sign-in from the redirect URL the provider sent the browser to (for a headless host). */
  completeLogin: { pendingId: string; callbackUrl: string };
  /** Forget the credentials of the server (they are shared by every agent that uses its URL). */
  logout: McpServerRef;
}
export interface McpResults {
  connect: { ok: boolean; message: string | null };
  reconnect: { ok: boolean; message: string | null };
  login: { pendingId: string; authorizationUrl: string };
  completeLogin: { ok: true };
  logout: Record<string, never>;
}
