/**
 * MCP on the primary: the host's `McpHost`, the credentials of OAuth servers and the logins.
 *
 * Credentials live in the database, sealed by the host's secret key. A server's credentials are
 * stored under a hash of its URL, not of the agent or the config that named it, so one sign-in
 * serves every agent and every machine that reaches that URL.
 *
 * Redirect URL: the provider sends the browser to `<origin>/mcp/oauth/callback`. The origin is
 * the host's configured public address when it has one (`--public-url`), else the origin the web
 * client reports it reached the host at (`location.origin`): that is by construction an address
 * the user's browser can open, and it is what the page already trusts. A client registered for
 * another redirect is registered again at the next login.
 */
import type {
  McpAuthState,
  McpCredentialCall,
  McpServerView,
} from "@eta/client-contracts";
import type { McpHostOptions } from "@eta/daemon";
import type { AuthProviderFor, McpScope, OAuthLogins } from "@eta/mcp";
import type { Database } from "bun:sqlite";
import type { Buffer } from "node:buffer";
import { McpHost, mcpServerKey, parseCredentialCall } from "@eta/daemon";
import {
  createOAuthLogins,
  createOAuthProvider,
  createRefreshDedupingFetch,
  lifecycleOf,
  LoginError,
} from "@eta/mcp";
import { CredentialRows } from "./credentials";
import { MCP_CALLBACK_PATH } from "./path";

const CALLBACK_PATH = MCP_CALLBACK_PATH;
/** The prefix of a plugin's source (`McpHost`). */
const PLUGIN = "plugin:";

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

export interface McpServiceOptions {
  db: Database;
  key: Buffer;
  dataDir: string;
  home: string;
  agents: () => { id: string; name: string }[];
  /** The MCP servers of an agent's plugins (`Plugins.mcpSourcesFor`). */
  pluginSources?: McpHostOptions["pluginSources"];
  publicUrl?: string | undefined;
  changed: () => void;
  warn: (message: string) => void;
  fetch?: McpHostOptions["fetch"];
  manager?: Partial<McpHostOptions["manager"]>;
}

export class McpService {
  readonly host: McpHost;
  readonly credentials: CredentialRows;
  readonly #options: McpServiceOptions;
  readonly #fetch: Awaited<ReturnType<typeof createRefreshDedupingFetch>>;
  readonly #logins = new Map<string, OAuthLogins>();
  readonly #pending = new Map<
    string,
    { logins: OAuthLogins; redirectUrl: string }
  >();
  #redirect: string;

  constructor(options: McpServiceOptions) {
    this.#options = options;
    this.credentials = new CredentialRows(options.db, options.key);
    this.#fetch = (
      typeof options.fetch === "function"
        ? options.fetch
        : createRefreshDedupingFetch()
    ) as never;
    this.#redirect = `${originOf(options.publicUrl) ?? "http://127.0.0.1"}${CALLBACK_PATH}`;
    const authProviderFor: AuthProviderFor | undefined = (_name, context) =>
      createOAuthProvider({
        serverKey: mcpServerKey(context.url),
        serverUrl: context.url,
        store: this.credentials,
        redirectUrl: this.#redirect,
      });
    this.host = new McpHost({
      dataDir: options.dataDir,
      home: options.home,
      warn: options.warn,
      authProviderFor,
      pluginSources: options.pluginSources,
      fetch: options.fetch,
      manager: options.manager,
    });
  }

  /** The fetch that makes everything refreshing a sign-in share one request. */
  get refreshFetch(): Awaited<ReturnType<typeof createRefreshDedupingFetch>> {
    return this.#fetch;
  }

  list(): McpServerView[] {
    const views = new Map<string, McpServerView>();
    const add = (
      agent: { id: string; name: string },
      scope: McpScope,
    ): void => {
      const replaced = scope
        .overridden()
        .filter(({ definition }) => definition.source.startsWith(PLUGIN));
      for (const status of scope.status()) {
        const key = `${agent.id}\0${status.source}\0${status.name}`;
        if (views.has(key)) continue;
        const definition = scope.definition(status.name);
        views.set(key, {
          overriddenBy: null,
          overrides:
            replaced.find(({ definition }) => definition.name === status.name)
              ?.definition.source ?? null,
          agentId: agent.id,
          agentName: agent.name,
          server: status.name,
          source: status.source,
          transport: transportOf(definition),
          lifecycle: status.lifecycle,
          state: status.state,
          toolCount: status.toolCount,
          error: status.error ?? null,
          auth: this.#authOf(definition, status.source, status.state),
        });
      }
      // A plugin's server another source replaced: shown where it was declared, and by what.
      for (const { definition, by } of replaced) {
        const key = `${agent.id}\0${definition.source}\0${definition.name}`;
        if (views.has(key)) continue;
        views.set(key, {
          agentId: agent.id,
          agentName: agent.name,
          server: definition.name,
          source: definition.source,
          transport: transportOf(definition),
          lifecycle: lifecycleOf(definition),
          state: "not-connected",
          toolCount: 0,
          error: null,
          auth: "none",
          overriddenBy: { source: by, name: definition.name },
          overrides: null,
        });
      }
    };
    const agents = this.#options.agents();
    const live = this.host.scopes();
    for (const agent of agents) {
      for (const { owner, scope } of live)
        if (owner === agent.id) add(agent, scope);
      add(agent, this.host.inspect(agent.id));
    }
    return [...views.values()].sort(
      (a, b) =>
        a.agentName.localeCompare(b.agentName) ||
        a.source.localeCompare(b.source) ||
        a.server.localeCompare(b.server),
    );
  }

  /**
   * A server the user declared `auth: "oauth"` needs a login until it has one. A plugin's remote
   * server is OAuth only because nothing says it is not, so it asks for a login only when the
   * server did (`needs-auth`): one that needs none shows no button. Anything not `"oauth"`
   * (`auth: false` included) never shows one.
   */
  #authOf(
    definition: ReturnType<McpScope["definition"]>,
    source: string,
    state: string,
  ): McpAuthState {
    if (definition?.auth !== "oauth" || definition.url === undefined)
      return "none";
    if (state === "needs-auth") return "needs_login";
    if (this.credentials.has(mcpServerKey(definition.url), "tokens"))
      return "signed_in";
    return source.startsWith(PLUGIN) ? "none" : "needs_login";
  }

  #scopeOf(agentId: string, server: string): McpScope {
    for (const { owner, scope } of this.host.scopes())
      if (owner === agentId && scope.definition(server) !== undefined)
        return scope;
    const scope = this.host.inspect(agentId);
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

  async login(
    agentId: string,
    server: string,
    redirectOrigin: string | undefined,
  ): Promise<{ pendingId: string; authorizationUrl: string }> {
    const definition = this.#scopeOf(agentId, server).definition(server);
    if (definition?.auth !== "oauth" || definition.url === undefined)
      throw new Error(`${server} does not sign in with OAuth`);
    return await this.loginUrl(
      definition.url,
      definition.headers,
      redirectOrigin,
    );
  }

  /**
   * Start a login for a server by its URL alone: credentials are kept per URL hash, so no agent is
   * needed. A plugin's panel uses this; the callback and the pending state are the same as `login`.
   */
  async loginUrl(
    url: string,
    headers: Record<string, string> | undefined,
    redirectOrigin: string | undefined,
  ): Promise<{ pendingId: string; authorizationUrl: string }> {
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
      serverKey: mcpServerKey(url),
      serverUrl: url,
      ...(headers === undefined ? {} : { headers }),
    });
    this.#pending.set(pending.pendingId, { logins, redirectUrl });
    return {
      pendingId: pending.pendingId,
      authorizationUrl: pending.authorizationUrl,
    };
  }

  async completeLogin(
    pendingId: string,
    callbackUrl: string,
  ): Promise<string | undefined> {
    const held = this.#pending.get(pendingId);
    if (held === undefined)
      throw new LoginError(
        "unknown_pending",
        "No pending login with that id (it may have been cancelled, replaced or already completed)",
      );
    try {
      const { serverKey, note } = await held.logins.completeLogin(
        pendingId,
        callbackUrl,
      );
      this.#pending.delete(pendingId);
      this.#options.changed();
      void this.#retry(serverKey);
      return note;
    } catch (error) {
      if (!(error instanceof LoginError && error.code === "state_mismatch"))
        this.#pending.delete(pendingId);
      throw error;
    }
  }

  async #retry(serverKey: string): Promise<void> {
    for (const agent of this.#options.agents()) {
      const scope = this.host.inspect(agent.id);
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

  async logout(agentId: string, server: string): Promise<void> {
    const definition = this.#scopeOf(agentId, server).definition(server);
    if (definition?.url === undefined)
      throw new Error(`${server} has no URL to sign out of`);
    await this.#forget(definition.url);
    await this.host.manager.servers.close(agentId, server);
    this.#options.changed();
  }

  async #forget(url: string): Promise<void> {
    const serverKey = mcpServerKey(url);
    for (const logins of this.#logins.values()) await logins.logout(serverKey);
    for (const kind of [
      "tokens",
      "clientInformation",
      "codeVerifier",
      "discoveryState",
    ] as const)
      await this.credentials.delete(serverKey, kind);
  }

  /** The key a URL's credentials are kept under. */
  keyOf(url: string): string {
    return mcpServerKey(url);
  }

  /** Whether a sign-in is stored for this URL. */
  /** Which stored sign-in this URL has now (a stamp, not the token); undefined when none. */
  signInStamp(url: string): string | undefined {
    return this.credentials.stamp(mcpServerKey(url), "tokens");
  }

  signedIn(url: string): boolean {
    return this.credentials.has(mcpServerKey(url), "tokens");
  }

  /**
   * For a plugin's connection test: the provider that sends this URL's stored sign-in (refreshing
   * it when it has expired), or undefined when none is stored, so a test never starts a login.
   */
  storedAuthProvider(url: string): AuthProviderFor | undefined {
    if (!this.signedIn(url)) return undefined;
    return (_name, context) =>
      createOAuthProvider({
        serverKey: mcpServerKey(context.url),
        serverUrl: context.url,
        store: this.credentials,
        redirectUrl: this.#redirect,
      });
  }

  /** Sign out of a URL (a plugin's panel); the servers using it reconnect without the token. */
  async logoutUrl(url: string): Promise<void> {
    await this.#forget(url);
    for (const agent of this.#options.agents()) {
      const scope = this.host.inspect(agent.id);
      for (const definition of scope.servers())
        if (
          definition.url !== undefined &&
          mcpServerKey(definition.url) === mcpServerKey(url)
        )
          await this.host.manager.servers.close(agent.id, definition.name);
    }
    this.#options.changed();
  }

  /**
   * An uninstalled plugin's sign-ins: removed only for a URL no other server uses (another plugin,
   * given in `others`, or any other source of any agent), since the tokens are shared by URL.
   */
  async releaseUrls(
    urls: readonly string[],
    plugin: string,
    others: ReadonlySet<string>,
  ): Promise<void> {
    const used = new Set(others);
    for (const agent of this.#options.agents())
      for (const definition of this.host.inspect(agent.id).servers())
        if (
          definition.url !== undefined &&
          definition.source !== `${PLUGIN}${plugin}`
        )
          used.add(mcpServerKey(definition.url));
    for (const url of urls)
      if (!used.has(mcpServerKey(url))) await this.#forget(url);
    this.#options.changed();
  }

  /**
   * A daemon's read, write or removal of a server's OAuth state (`mcp.credential`). The rows are
   * the ones a login here writes, so a session on any machine uses the same sign-in, and a token
   * a daemon refreshes is what the next session reads. Only `tokens`, `clientInformation` and
   * `discoveryState`, under a URL's hash: `parseCredentialCall` refuses anything else.
   */
  async relay(raw: unknown): Promise<unknown> {
    const call: McpCredentialCall = parseCredentialCall(raw);
    if (call.op === "get")
      return (await this.credentials.get(call.serverKey, call.kind)) ?? null;
    if (call.op === "set")
      await this.credentials.set(
        call.serverKey,
        call.kind,
        call.value as never,
      );
    else await this.credentials.delete(call.serverKey, call.kind);
    // A token saved or dropped changes what the settings page says.
    this.#options.changed();
    return null;
  }

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
    let note: string | undefined;
    try {
      note = await this.completeLogin(
        state,
        `${held.redirectUrl}${url.search}`,
      );
    } catch (error) {
      return page(
        400,
        "Sign-in failed",
        error instanceof LoginError ? error.message : messageOf(error),
      );
    }
    return page(
      200,
      "Signed in",
      note ?? "You can close this tab and go back to eta.",
    );
  }

  async close(): Promise<void> {
    await this.host.close();
  }
}

function transportOf(
  definition: ReturnType<McpScope["definition"]>,
): McpServerView["transport"] {
  if (definition?.command !== undefined) return "stdio";
  return definition?.type === "sse" ? "sse" : "http";
}
