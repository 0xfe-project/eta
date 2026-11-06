/**
 * MCP on this machine, for the realm of the sessions the host opens here.
 *
 * One `McpManager` per host: connections, the metadata cache and launch resolutions under
 * `<dataDir>/mcp/`. Every session gets a scope of it keyed by its agent, so the sessions of one
 * agent share that agent's connections and two agents never do. What a session's realm sees is
 * `createMcpRealmAdapter(scope)`: `import "mcp:<server>"` and `eta.mcp`.
 *
 * Where servers are declared, later overriding earlier by name: the user's `~/.eta/mcp.json`,
 * then the `.mcp.json` of the session's working directory. Both are read when a session opens,
 * so an edit reaches the next session.
 *
 * OAuth: `authProviderFor` is the credential table's provider (`./service`); without it an
 * `auth: "oauth"` server reports that it needs sign-in. Not here yet: servers declared by bundles.
 * A session on another machine gets MCP from that machine's host.
 */
import type {
  AuthProviderFor,
  McpConfigSource,
  McpManagerOptions,
  McpScope,
} from "@eta/mcp";
import type { SessionMcpWiring, SessionMeta } from "@eta/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMcpRealmAdapter, McpManager, parseMcpServers } from "@eta/mcp";

/** The owner of sessions that belong to no agent. */
const BARE = "session";

export interface McpHostOptions {
  /** The host's state directory; the library's files go under `mcp/`. */
  dataDir: string;
  /** The user's home: `~/.eta/mcp.json` is under it. */
  home: string;
  warn: (message: string) => void;
  /** OAuth for `auth: "oauth"` servers; without it such a server reports it needs sign-in. */
  authProviderFor?: AuthProviderFor | undefined;
  /** The fetch of HTTP transports and their token requests. */
  fetch?: McpManagerOptions["fetch"] | undefined;
  /** Overrides of the library's manager (a test turns timers and launch resolution off). */
  manager?: Partial<McpManagerOptions> | undefined;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** One `mcp.json`: a missing file is no servers, a broken one is a warning. */
function readSource(
  name: string,
  path: string,
  warn: (message: string) => void,
): McpConfigSource | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      warn(`[eta] ${path}: ${messageOf(error)}`);
    return undefined;
  }
  try {
    const { servers, issues } = parseMcpServers(JSON.parse(text));
    for (const issue of issues) warn(`[eta] ${path}: ${issue}`);
    return { name, servers };
  } catch (error) {
    warn(`[eta] ${path}: ${messageOf(error)}`);
    return undefined;
  }
}

/** A session's sources, in the order that decides a clash: the user's file, then the project's. */
function mcpSources(
  home: string,
  cwd: string | undefined,
  warn: (message: string) => void,
): McpConfigSource[] {
  const files: [string, string][] = [
    ["~/.eta/mcp.json", join(home, ".eta", "mcp.json")],
    ...(cwd === undefined
      ? []
      : [[".mcp.json", join(cwd, ".mcp.json")] as [string, string]]),
  ];
  return files.flatMap(([name, path]) => {
    const source = readSource(name, path, warn);
    return source === undefined || Object.keys(source.servers).length === 0
      ? []
      : [source];
  });
}

export class McpHost {
  readonly manager: McpManager;
  readonly #options: McpHostOptions;
  /** One background warm-up at a time per owner: a second session finds the cache the first filled. */
  readonly #warming = new Map<string, Promise<unknown>>();
  /** The scopes the open sessions hold, by owner, for the status page. */
  readonly #live = new Map<string, Set<McpScope>>();
  /** One scope per owner that no session holds, for the status page and sign-ins. */
  readonly #inspectors = new Map<string, McpScope>();

  constructor(options: McpHostOptions) {
    this.#options = options;
    const dir = join(options.dataDir, "mcp");
    this.manager = new McpManager({
      cacheFile: (owner) =>
        join(dir, "cache", `${encodeURIComponent(owner)}.json`),
      resolverCacheFile: join(dir, "launch-resolutions.json"),
      ...(options.authProviderFor === undefined
        ? {}
        : { authProviderFor: options.authProviderFor }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...options.manager,
    });
  }

  /** The sources a session in this directory would get; no directory is the user's file alone. */
  sourcesFor(cwd: string | undefined): McpConfigSource[] {
    return mcpSources(this.#options.home, cwd, this.#options.warn);
  }

  /**
   * A scope no session holds, for the status page: an owner's servers from the user's file, as a
   * new session would see them. It shares the owner's connections and cache.
   */
  inspect(owner: string): McpScope {
    const sources = this.sourcesFor(undefined);
    const found = this.#inspectors.get(owner);
    if (found !== undefined) {
      found.setSources(sources);
      return found;
    }
    const scope = this.manager.scope({ owner, sources });
    this.#inspectors.set(owner, scope);
    return scope;
  }

  /** The scopes the open sessions hold, for the status page. */
  scopes(): { owner: string; scope: McpScope }[] {
    return [...this.#live].flatMap(([owner, scopes]) =>
      [...scopes].map((scope) => ({ owner, scope })),
    );
  }

  /** The `mcpFor` hook of the session manager: undefined when no server is declared. */
  readonly sessionMcp = (meta: SessionMeta): SessionMcpWiring | undefined => {
    const sources = this.sourcesFor(meta.cwd);
    if (sources.length === 0) return undefined;
    const owner = meta.agentId ?? BARE;
    const scope = this.manager.scope({ owner, sources, cwd: meta.cwd });
    let live = this.#live.get(owner);
    if (live === undefined) this.#live.set(owner, (live = new Set()));
    live.add(scope);
    let closed = false;
    // Discovery reads the cache; a server never read yet is read once in the background, so
    // opening a session never waits for one. `import "mcp:<server>"` connects on its own.
    const warming = (this.#warming.get(owner) ?? Promise.resolve())
      .then(() => (closed ? undefined : scope.warmUp()))
      .catch((error: unknown) =>
        this.#options.warn(
          `[eta] MCP warm-up for ${owner}: ${messageOf(error)}`,
        ),
      )
      .finally(() => {
        if (this.#warming.get(owner) === warming) this.#warming.delete(owner);
      });
    this.#warming.set(owner, warming);
    return {
      sink: createMcpRealmAdapter(scope),
      dispose: () => {
        closed = true;
        scope.dispose();
        const scopes = this.#live.get(owner);
        scopes?.delete(scope);
        if (scopes?.size === 0) this.#live.delete(owner);
      },
    };
  };

  async close(): Promise<void> {
    await this.manager.closeAll();
  }
}
