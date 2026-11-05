/**
 * The library's entry point: connections, metadata caches and observed output shapes for any
 * number of owners, and `scope()` to get one owner's view of its servers.
 *
 * A host (the primary node, or a daemon) creates one `McpManager`. For each agent session it asks
 * for a scope with the sources that apply (the user's file, the session's project file); scopes of the same owner share connections, so a second session of an agent does
 * not start the agent's servers again.
 */

import type { OutputGuardOptions } from "./output-guard";
import type { ObservedOutputs } from "./output-shape";
import type { ScopeHost, ScopeOptions } from "./scope";
import type { Connection, ManagerOptions } from "./server-manager";
import type { McpServerDefinition, ServerCacheEntry } from "./types";
import { MetadataCache } from "./metadata-cache";
import { seedObservedOutputs } from "./output-shape";
import { McpScope } from "./scope";
import { ServerManager } from "./server-manager";

export interface McpManagerOptions extends ManagerOptions {
  /** The metadata cache file; a function gives each owner its own. */
  cacheFile: string | ((owner: string) => string);
  /** A directory for results and descriptions too large to hand to the model; they are saved here. */
  outputDir: string;
  /** Where launch resolutions (npx, bunx, uvx) are remembered for 24 hours. */
  resolverCacheFile?: string;
  /** Output limits; defaults are 50 KiB and 2000 lines. */
  maxOutputBytes?: number;
  maxOutputLines?: number;
}

export class McpManager {
  /** The connections. Exposed for status pages and tests; most callers need only `scope`. */
  readonly servers: ServerManager;
  private readonly options: McpManagerOptions;
  private readonly now: () => number;
  private readonly caches = new Map<string, MetadataCache>();
  private readonly observed = new Map<
    string,
    { hash: string; outputs: ObservedOutputs }
  >();
  private readonly scopes = new Map<string, Set<McpScope>>();
  private readonly host: ScopeHost;

  constructor(options: McpManagerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.servers = new ServerManager({
      ...options,
      resolvers:
        options.resolvers === false
          ? false
          : {
              ...(options.resolverCacheFile
                ? { cacheFile: options.resolverCacheFile }
                : {}),
              ...options.resolvers,
            },
    });
    const guard: OutputGuardOptions = {
      dir: options.outputDir,
      maxBytes: options.maxOutputBytes,
      maxLines: options.maxOutputLines,
    };
    this.host = {
      manager: this.servers,
      cacheFor: (owner) => this.cacheFor(owner),
      observedFor: (owner, definition) => this.observedFor(owner, definition),
      entryOf: (connection) => this.entryOf(connection),
      persist: (connection) => this.persist(connection),
      unregister: (scope) => this.scopes.get(scope.owner)?.delete(scope),
      guard,
      hooks: options.hooks ?? {},
      now: this.now,
    };
    // A server announcing new tools updates the cache and everyone looking at it.
    this.servers.onToolsChanged((connection) => {
      this.persist(connection);
      for (const scope of this.scopes.get(connection.owner) ?? []) scope.emit();
    });
  }

  /** One owner's view of its servers. Cheap; make one per session and `dispose` it with the session. */
  scope(options: ScopeOptions): McpScope {
    const scope = new McpScope(this.host, options);
    let owned = this.scopes.get(options.owner);
    if (!owned) this.scopes.set(options.owner, (owned = new Set()));
    owned.add(scope);
    return scope;
  }

  /** Closes every connection of one owner (an agent was deleted, say). */
  async closeOwner(owner: string): Promise<void> {
    await this.servers.closeOwner(owner);
  }

  /** Closes everything and stops the timers. The manager cannot be used afterwards. */
  async closeAll(): Promise<void> {
    await this.servers.closeAll();
    this.scopes.clear();
  }

  /** One idle and keep-alive pass, normally run by a timer. */
  async sweep(): Promise<void> {
    await this.servers.sweep();
  }

  private cacheFor(owner: string): MetadataCache {
    const path =
      typeof this.options.cacheFile === "string"
        ? this.options.cacheFile
        : this.options.cacheFile(owner);
    let cache = this.caches.get(path);
    if (!cache)
      this.caches.set(path, (cache = new MetadataCache(path, this.now)));
    return cache;
  }

  /** Output shapes by tool for one owner's server; seeded from the cache, reset when the config changes. */
  private observedFor(
    owner: string,
    definition: McpServerDefinition,
  ): ObservedOutputs {
    const key = `${owner}\u0000${definition.name}`;
    const existing = this.observed.get(key);
    if (existing?.hash === definition.hash) return existing.outputs;
    const outputs: ObservedOutputs = new Map();
    const entry = this.cacheFor(owner).get(definition.name, definition.hash);
    seedObservedOutputs(outputs, entry?.outputShapes, entry?.tools ?? []);
    this.observed.set(key, { hash: definition.hash, outputs });
    return outputs;
  }

  private entryOf(connection: Connection): Omit<ServerCacheEntry, "cachedAt"> {
    const observed = this.observedFor(connection.owner, connection.definition);
    return {
      configHash: connection.definition.hash,
      tools: connection.tools,
      ...(connection.instructions === undefined
        ? {}
        : { instructions: connection.instructions }),
      ...(observed.size > 0
        ? { outputShapes: Object.fromEntries(observed) }
        : {}),
    };
  }

  private persist(connection: Connection): void {
    if (connection.status !== "connected") return;
    this.cacheFor(connection.owner).save({
      [connection.definition.name]: this.entryOf(connection),
    });
  }
}
