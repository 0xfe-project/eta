/**
 * MCP on the primary: the host's `McpHost`, the credentials of OAuth servers and the logins.
 *
 * `host` is what the primary's own sessions use (`McpHost` from `@eta/daemon`, shared with the
 * daemon). This adds what only the primary has: the credential table, the sign-in flow, the
 * callback the browser comes back to, the relay that serves a daemon's token reads and writes, and
 * the status page's view of every agent's servers.
 *
 * **Server key.** A server's credentials are stored under a hash of its URL, not of the agent or
 * the config that named it, so one sign-in serves every agent and every machine that reaches that
 * URL.
 *
 * **Redirect URL.** The provider sends the browser to `<origin>/mcp/oauth/callback`. The origin is
 * the host's configured public address when it has one (`--public-url`, for a host behind a proxy
 * whose own address is not what the browser uses), else the origin the web client reports it
 * reached the host at (`location.origin`): that is by construction an address the user's browser
 * can open, and it is what the page already trusts. A client registered for another redirect is
 * registered again at the next login.
 */
import type {
  McpAuthState,
  McpCredentialCall,
  McpServerView,
  McpTransport,
} from "@eta/client-contracts";
import type { McpHostOptions, McpSessionInput } from "@eta/daemon";
import type { McpConfigSource, McpScope, OAuthLogins } from "@eta/mcp";
import type { Database } from "bun:sqlite";
import type { Buffer } from "node:buffer";
import { McpHost, mcpServerKey, RELAYED_KINDS } from "@eta/daemon";
import {
  createOAuthLogins,
  createOAuthProvider,
  createRefreshDedupingFetch,
  LoginError,
} from "@eta/mcp";
import { CredentialRows } from "./credentials";
import { MCP_CALLBACK_PATH } from "./path";

const CALLBACK_PATH = MCP_CALLBACK_PATH;

/** A page with a sentence on it, for the tab the provider's redirect opens. */
function page(status: number, title: string, detail: string): Response {
  const escape = (text: string): string =>
    text.replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char]!,
    );
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#222}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.2rem}p{color:#555}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}p{color:#aaa}}</style></head><body><main><h1>${escape(title)}</h1><p>${escape(detail)}</p></main></body></html>`;
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
    },
  });
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** An origin from what a client or an operator wrote, or nothing when it is no web address. */
function originOf(text: string | undefined): string | undefined {
  if (text === undefined || text === "") return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

/** What a test sets to run the library against fake servers; a real host leaves it alone. */
export interface McpTuning {
  /** The library's `fetch` (a fake authorization server). */
  fetch?: McpHostOptions["fetch"];
  manager?: McpHostOptions["manager"];
  /** How long an agent's connections outlive its last session. */
  graceMs?: number | undefined;
}

export interface McpServiceOptions extends McpTuning {
  db: Database;
  /** The host's key, which credentials are sealed under. */
  key: Buffer;
  dataDir: string;
  home: string;
  /** The agents there are, for the status page. */
  agents: () => { id: string; name: string }[];
  /** The servers the bundles of an agent bring, one source each. */
  bundleSources: (
    agentId: string | undefined,
    cwd: string | undefined,
  ) => McpConfigSource[];
  /** The address the browser reaches the host at, when it is not what the client sees. */
  publicUrl?: string | undefined;
  /** Say that the `mcp` target moved. */
  changed: () => void;
  warn: (message: string) => void;
}

export class McpService {
  readonly host: McpHost;
  readonly credentials: CredentialRows;
  readonly #options: McpServiceOptions;
  readonly #fetch: NonNullable<McpHostOptions["fetch"]>;
  /** One login flow per redirect URL (a client is registered for one). */
  readonly #logins = new Map<string, OAuthLogins>();
  /** Which flow holds a pending login: the callback only has the `state`. */
  readonly #pending = new Map<
    string,
    { logins: OAuthLogins; redirectUrl: string }
  >();
  /** The redirect connect-mode providers name; it is never visited. */
  #redirect: string;

  constructor(options: McpServiceOptions) {
    this.#options = options;
    this.credentials = new CredentialRows(options.db, options.key);
    this.#fetch = options.fetch ?? createRefreshDedupingFetch();
    this.#redirect = `${originOf(options.publicUrl) ?? "http://127.0.0.1"}${CALLBACK_PATH}`;
    this.host = new McpHost({
      dataDir: options.dataDir,
      home: options.home,
      warn: options.warn,
      authProviderFor: (_name, context) =>
        // Connect mode: it never registers a client or redirects; a server that needs a login
        // reports that, and the login is `login` below.
        createOAuthProvider({
          serverKey: mcpServerKey(context.url),
          serverUrl: context.url,
          store: this.credentials,
          redirectUrl: this.#redirect,
        }),
      fetch: this.#fetch,
      graceMs: options.graceMs,
      manager: options.manager,
    });
  }

  /** The host's own sessions' MCP tools. */
  sessionTools(input: Omit<McpSessionInput, "bundles">) {
    return this.host.sessionTools({
      ...input,
      bundles: this.#options.bundleSources(input.meta.agentId, input.meta.cwd),
    });
  }

  /* ----------------------------------------------------------------- relay */

  /** A daemon's read, write or forget of OAuth state; the daemon may not touch anything else. */
  async relay(call: McpCredentialCall): Promise<unknown> {
    if (
      typeof call !== "object" ||
      call === null ||
      !(RELAYED_KINDS as readonly string[]).includes(call.kind) ||
      typeof call.serverKey !== "string" ||
      !/^[0-9a-f]{64}$/.test(call.serverKey)
    )
      throw new Error("mcp.credential: not a credential this link may touch");
    switch (call.op) {
      case "get":
        return (await this.credentials.get(call.serverKey, call.kind)) ?? null;
      case "set":
        await this.credentials.set(
          call.serverKey,
          call.kind,
          call.value as never,
        );
        this.#options.changed();
        return null;
      case "delete":
        await this.credentials.delete(call.serverKey, call.kind);
        this.#options.changed();
        return null;
      default:
        throw new Error("mcp.credential: unknown operation");
    }
  }

  /* ---------------------------------------------------------------- status */

  /** Every agent's servers, from the sources a session would get and from the live sessions. */
  list(): McpServerView[] {
    const views = new Map<string, McpServerView>();
    const add = (
      agent: { id: string; name: string },
      scope: McpScope,
    ): void => {
      for (const status of scope.status()) {
        const key = `${agent.id}\0${status.source}\0${status.name}`;
        if (views.has(key)) continue;
        const definition = scope.definition(status.name);
        views.set(key, {
          agentId: agent.id,
          agentName: agent.name,
          server: status.name,
          source: status.source,
          transport: transportOf(definition),
          lifecycle: status.lifecycle,
          state: status.state,
          toolCount: status.toolCount,
          error: status.error ?? null,
          auth: this.#authOf(definition, status.state),
        });
      }
    };
    const agents = this.#options.agents();
    const live = this.host.scopes();
    for (const agent of agents) {
      // The project's own `.mcp.json` shows through the live sessions that read it.
      for (const { owner, scope } of live)
        if (owner === agent.id) add(agent, scope);
      add(
        agent,
        this.host.inspect(
          agent.id,
          this.host.sourcesFor(
            undefined,
            this.#options.bundleSources(agent.id, undefined),
          ),
        ),
      );
    }
    return [...views.values()].sort(
      (a, b) =>
        a.agentName.localeCompare(b.agentName) ||
        a.source.localeCompare(b.source) ||
        a.server.localeCompare(b.server),
    );
  }

  #authOf(
    definition: ReturnType<McpScope["definition"]>,
    state: string,
  ): McpAuthState {
    if (definition?.auth !== "oauth" || definition.url === undefined)
      return "none";
    if (state === "needs-auth") return "needs_login";
    return this.credentials.has(mcpServerKey(definition.url), "tokens")
      ? "signed_in"
      : "needs_login";
  }

  /** The scope that knows a server of this agent: a live one first, else the inspector's. */
  #scopeOf(agentId: string, server: string): McpScope {
    for (const { owner, scope } of this.host.scopes())
      if (owner === agentId && scope.definition(server) !== undefined)
        return scope;
    const scope = this.#inspector(agentId);
    if (scope.definition(server) === undefined)
      throw new Error(`agent ${agentId} has no MCP server ${server}`);
    return scope;
  }

  async connect(
    agentId: string,
    server: string,
    reconnect: boolean,
  ): Promise<{ ok: boolean; message: string | null }> {
    const scope = this.#scopeOf(agentId, server);
    if (reconnect) await this.host.manager.servers.close(agentId, server);
    const outcome = await scope.connect(server, { force: true });
    this.#options.changed();
    return outcome.ok
      ? { ok: true, message: null }
      : { ok: false, message: outcome.message };
  }

  /* ----------------------------------------------------------------- login */

  #loginsFor(redirectUrl: string): OAuthLogins {
    let logins = this.#logins.get(redirectUrl);
    if (logins === undefined) {
      logins = createOAuthLogins({
        store: this.credentials,
        redirectUrl,
        fetchFn: this.#fetch,
      });
      this.#logins.set(redirectUrl, logins);
    }
    return logins;
  }

  /** Start a sign-in to an OAuth server of an agent. */
  async login(
    agentId: string,
    server: string,
    redirectOrigin: string | undefined,
  ): Promise<{ pendingId: string; authorizationUrl: string }> {
    const definition = this.#scopeOf(agentId, server).definition(server);
    if (definition?.auth !== "oauth" || definition.url === undefined)
      throw new Error(`${server} does not sign in with OAuth`);
    const origin =
      originOf(this.#options.publicUrl) ?? originOf(redirectOrigin);
    if (origin === undefined)
      throw new Error(
        "the host does not know the address your browser reaches it at; start it with --public-url",
      );
    const redirectUrl = `${origin}${CALLBACK_PATH}`;
    const logins = this.#loginsFor(redirectUrl);
    this.#redirect = redirectUrl;
    const pending = await logins.beginLogin({
      serverKey: mcpServerKey(definition.url),
      serverUrl: definition.url,
      ...(definition.headers === undefined
        ? {}
        : { headers: definition.headers }),
    });
    this.#pending.set(pending.pendingId, { logins, redirectUrl });
    return {
      pendingId: pending.pendingId,
      authorizationUrl: pending.authorizationUrl,
    };
  }

  /** Finish a sign-in from the redirect URL (the callback route, or pasted by the user). */
  async completeLogin(pendingId: string, callbackUrl: string): Promise<void> {
    const held = this.#pending.get(pendingId);
    if (held === undefined)
      throw new LoginError(
        "unknown_pending",
        "No pending login with that id (it may have been cancelled, replaced or already completed)",
      );
    try {
      const { serverKey } = await held.logins.completeLogin(
        pendingId,
        callbackUrl,
      );
      this.#pending.delete(pendingId);
      this.#options.changed();
      void this.#retry(serverKey);
    } catch (error) {
      // A wrong state changes nothing: the login stays pending for the right redirect. Any other
      // outcome (denied, expired, exchange failed) ends it.
      if (!(error instanceof LoginError && error.code === "state_mismatch"))
        this.#pending.delete(pendingId);
      throw error;
    }
  }

  /** Servers that were waiting for this sign-in connect now instead of at their next call. */
  async #retry(serverKey: string): Promise<void> {
    for (const agent of this.#options.agents()) {
      const scope = this.#inspector(agent.id);
      for (const definition of scope.servers()) {
        if (
          definition.auth !== "oauth" ||
          definition.url === undefined ||
          mcpServerKey(definition.url) !== serverKey
        )
          continue;
        await this.host.manager.servers.close(agent.id, definition.name);
        await scope.connect(definition.name, { force: true });
      }
    }
    this.#options.changed();
  }

  #inspector(agentId: string): McpScope {
    return this.host.inspect(
      agentId,
      this.host.sourcesFor(
        undefined,
        this.#options.bundleSources(agentId, undefined),
      ),
    );
  }

  /** Forget the credentials of an agent's server (every agent that uses the URL loses them). */
  async logout(agentId: string, server: string): Promise<void> {
    const definition = this.#scopeOf(agentId, server).definition(server);
    if (definition?.url === undefined)
      throw new Error(`${server} has no URL to sign out of`);
    const serverKey = mcpServerKey(definition.url);
    for (const logins of this.#logins.values()) await logins.logout(serverKey);
    for (const kind of [
      "tokens",
      "clientInformation",
      "codeVerifier",
      "discoveryState",
    ] as const)
      await this.credentials.delete(serverKey, kind);
    await this.host.manager.servers.close(agentId, server);
    this.#options.changed();
  }

  /* -------------------------------------------------------------- callback */

  /**
   * The browser's return from the provider. It completes a login that this host started and is
   * waiting for, found by its `state`, and does nothing else: any other state, or none, is a page
   * saying so and no change. It has no token gate (the browser arrives from another site), which
   * is why it must stay this small.
   */
  async route(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname !== CALLBACK_PATH) return undefined;
    if (request.method !== "GET") return undefined;
    const state = url.searchParams.get("state");
    const held = state === null ? undefined : this.#pending.get(state);
    if (state === null || held === undefined)
      return page(
        400,
        "Sign-in not found",
        "No sign-in is waiting for this address. Start it again from eta's settings.",
      );
    try {
      // The redirect the login named, with the query that came back.
      await this.completeLogin(state, `${held.redirectUrl}${url.search}`);
    } catch (error) {
      return page(
        400,
        "Sign-in failed",
        error instanceof LoginError ? error.message : messageOf(error),
      );
    }
    return page(200, "Signed in", "You can close this tab and go back to eta.");
  }

  async close(): Promise<void> {
    await this.host.close();
  }
}

function transportOf(
  definition: ReturnType<McpScope["definition"]>,
): McpTransport {
  if (definition?.command !== undefined) return "stdio";
  return definition?.type === "sse" ? "sse" : "http";
}
