// Ported from pi-mcp-adapter/init.ts, proxy-modes.ts (executeCall), tool-approval.ts and direct-tools.ts (MIT, see ../NOTICE): the call path, warm-up and status of one owner's servers.
/**
 * One owner's view of the servers: which are configured, what is known about them, and how to use
 * them. A scope is cheap and can be rebuilt freely; connections, the metadata cache and observed
 * output shapes live in the manager and outlast it.
 *
 * Everything that reads (`tools`, `entries`, `status`, `instructions`) answers from a live
 * connection if there is one and from the metadata cache otherwise, so listing and searching
 * never start a server. Only `callTool`, `connect` and `warmUp` do.
 */

import type { MetadataCache } from "./metadata-cache";
import type { ObservedOutputs } from "./output-shape";
import type { SearchEntry } from "./search-ranking";
import type { Connection, ServerManager } from "./server-manager";
import type {
  ContentBlock,
  McpConfigSource,
  McpDelivery,
  McpExecuteContext,
  McpHooks,
  McpServerDefinition,
  McpToolResult,
  ServerCacheEntry,
  ServerStatus,
  ToolMeta,
} from "./types";
import {
  SdkError,
  SdkErrorCode,
  SdkHttpError,
} from "@modelcontextprotocol/client";
import { lifecycleOf, resolveServers } from "./config";
import { classifyCallError, DeliveryError, describeDelivery } from "./delivery";
import { schemaViolation } from "./json-schema";
import { isToolAllowed, qualifiedToolName } from "./names";
import {
  getObservedOutput,
  outputShapeKey,
  recordObservedOutput,
} from "./output-shape";
import { resolveSearchKeywords } from "./search-ranking";
import { ServerUnavailableError } from "./server-manager";

/** What the scope needs from the manager that owns it. */
export interface ScopeHost {
  manager: ServerManager;
  cacheFor: (owner: string) => MetadataCache;
  observedFor: (
    owner: string,
    definition: McpServerDefinition,
  ) => ObservedOutputs;
  /** What a live connection reports, as a cache entry. */
  entryOf: (connection: Connection) => Omit<ServerCacheEntry, "cachedAt">;
  /** Writes it to the owner's cache. */
  persist: (connection: Connection) => void;
  unregister: (scope: McpScope) => void;
  hooks: McpHooks;
  now: () => number;
}

export interface ScopeOptions {
  owner: string;
  sources: readonly McpConfigSource[];
  /** The directory stdio servers start in when their config names none. */
  cwd?: string | undefined;
  /** Hooks for calls made through this scope; each one replaces the manager's. */
  hooks?: McpHooks | undefined;
}

export type ConnectOutcome =
  | { ok: true; tools: ToolMeta[] }
  | {
      ok: false;
      error:
        | "needs_auth"
        | "connect_failed"
        | "server_backoff"
        | "aborted"
        | "server_disabled"
        | "not_found";
      message: string;
    };

export interface WarmUpOptions {
  signal?: AbortSignal;
  /** Servers connected at once. Default 10. */
  concurrency?: number;
}

export interface WarmUpResult {
  /** Servers whose tools were read and cached. */
  discovered: string[];
  /** Servers that failed, with why; they are not retried until their config changes. */
  failed: Record<string, string>;
  /** Servers that need sign-in; they are tried again when asked. */
  needsAuth: string[];
}

const DEFAULT_WARM_CONCURRENCY = 10;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/** A 404 on a request carrying a session id: the server forgot the session and did not run the call. */
function isTerminatedSession(error: unknown, hadSessionId: boolean): boolean {
  return hadSessionId && error instanceof SdkHttpError && error.status === 404;
}

export class McpScope {
  readonly owner: string;
  private readonly host: ScopeHost;
  private readonly cwd: string | undefined;
  private readonly hooks: McpHooks;
  private definitions = new Map<string, McpServerDefinition>();
  private issuesFound: string[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(host: ScopeHost, options: ScopeOptions) {
    this.host = host;
    this.owner = options.owner;
    this.cwd = options.cwd;
    this.hooks = { ...host.hooks, ...options.hooks };
    this.setSources(options.sources);
  }

  /** Replaces the configured servers. Connections to servers that are gone close. */
  setSources(sources: readonly McpConfigSource[]): void {
    const resolved = resolveServers(sources);
    const gone = [...this.definitions.keys()].filter(
      (name) => !resolved.servers.has(name),
    );
    this.definitions = resolved.servers;
    this.issuesFound = resolved.issues;
    for (const name of gone) void this.host.manager.close(this.owner, name);
    this.emit();
  }

  /** Problems found while merging the sources (overrides, malformed entries). */
  get issues(): readonly string[] {
    return this.issuesFound;
  }

  /** Called when what the scope knows changes: a warm-up finished, a server's tool list changed. */
  onUpdated(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(): void {
    for (const listener of this.listeners) listener();
  }

  servers(): McpServerDefinition[] {
    return [...this.definitions.values()];
  }

  definition(name: string): McpServerDefinition | undefined {
    return this.definitions.get(name);
  }

  private connection(name: string): Connection | undefined {
    return this.host.manager.get(this.owner, name);
  }

  // ---- reading (never connects) -------------------------------------------------------------

  /** The tool list from a live connection, else from the cache; undefined when neither knows. */
  private rawTools(definition: McpServerDefinition): ToolMeta[] | undefined {
    const live = this.connection(definition.name);
    if (
      live?.status === "connected" &&
      live.definition.hash === definition.hash
    ) {
      return live.tools;
    }
    return this.host.cacheFor(this.owner).get(definition.name, definition.hash)
      ?.tools;
  }

  /** The tools the model may use: `includeTools`/`excludeTools` applied. Undefined when unknown. */
  tools(server: string): ToolMeta[] | undefined {
    const definition = this.definitions.get(server);
    if (!definition) return undefined;
    return this.rawTools(definition)?.filter((tool) =>
      isToolAllowed(
        server,
        tool.name,
        definition.includeTools,
        definition.excludeTools,
      ),
    );
  }

  instructions(server: string): string | undefined {
    const definition = this.definitions.get(server);
    if (!definition) return undefined;
    const live = this.connection(server);
    if (
      live?.status === "connected" &&
      live.definition.hash === definition.hash
    ) {
      return live.instructions;
    }
    return this.host.cacheFor(this.owner).get(server, definition.hash)
      ?.instructions;
  }

  /** Output shapes seen so far for the server's tools, seeded from the cache. */
  observed(server: string): ObservedOutputs {
    const definition = this.definitions.get(server);
    return definition
      ? this.host.observedFor(this.owner, definition)
      : new Map();
  }

  failure(server: string): string | undefined {
    return this.host.manager.failures.describe(
      this.host.manager.failureKey(this.owner, server),
    );
  }

  /** Every searchable tool, skipping disabled servers and ones inside their failure backoff. */
  entries(only?: string): SearchEntry[] {
    const entries: SearchEntry[] = [];
    for (const definition of this.definitions.values()) {
      if (only !== undefined && definition.name !== only) continue;
      if (
        definition.disabled === true ||
        this.failure(definition.name) !== undefined
      )
        continue;
      for (const tool of this.tools(definition.name) ?? []) {
        entries.push({
          server: definition.name,
          tool,
          serverDescription: definition.description,
          keywords: resolveSearchKeywords(
            definition.searchKeywords,
            definition.name,
            tool.name,
          ),
        });
      }
    }
    return entries;
  }

  status(): ServerStatus[] {
    return this.servers().map((definition) => {
      const connection = this.connection(definition.name);
      const known = this.tools(definition.name);
      const failureKey = this.host.manager.failureKey(
        this.owner,
        definition.name,
      );
      const failure = this.host.manager.failures.message(failureKey);
      const failedAgo = this.host.manager.failures.ageSeconds(failureKey);
      let state: ServerStatus["state"] = "not-connected";
      if (definition.disabled === true) state = "disabled";
      else if (connection?.status === "connected") state = "connected";
      else if (connection?.status === "needs-auth") state = "needs-auth";
      else if (failure !== undefined) state = "failed";
      else if (known !== undefined) state = "cached";
      return {
        name: definition.name,
        source: definition.source,
        state,
        toolCount:
          state === "failed" || state === "disabled" ? 0 : (known?.length ?? 0),
        lifecycle: lifecycleOf(definition),
        ...(state === "failed" && failure !== undefined
          ? { error: failure }
          : {}),
        ...(state === "needs-auth" && connection?.authMessage !== undefined
          ? { error: connection.authMessage }
          : {}),
        ...(state === "failed" && failedAgo !== undefined
          ? { failedAgoSeconds: failedAgo }
          : {}),
        ...(definition.description === undefined
          ? {}
          : { description: definition.description }),
      };
    });
  }

  // ---- connecting ---------------------------------------------------------------------------

  /** Writes what a live connection learned to the cache. */
  persist(connection: Connection): void {
    if (connection.status !== "connected") return;
    this.host.persist(connection);
    this.emit();
  }

  /**
   * Connects the server (reconnecting a dropped one) and caches what it reports. Never throws: the
   * outcome says what happened. `force` ignores the failure backoff, for an explicit request.
   */
  async connect(
    server: string,
    options: { signal?: AbortSignal | undefined; force?: boolean } = {},
  ): Promise<ConnectOutcome> {
    const definition = this.definitions.get(server);
    if (!definition) {
      return {
        ok: false,
        error: "not_found",
        message: `Server "${server}" not found.`,
      };
    }
    if (definition.disabled === true) {
      return {
        ok: false,
        error: "server_disabled",
        message: `Server "${server}" is disabled.`,
      };
    }
    try {
      const connection = await this.host.manager.connect(
        this.owner,
        definition,
        {
          signal: options.signal,
          hooks: this.hooks,
          cwd: this.cwd,
          ...(options.force === undefined ? {} : { force: options.force }),
        },
      );
      if (connection.status === "needs-auth") {
        return {
          ok: false,
          error: "needs_auth",
          message: connection.authMessage ?? "sign-in is required",
        };
      }
      this.persist(connection);
      return { ok: true, tools: this.tools(server) ?? [] };
    } catch (error) {
      if (isAbort(error, options.signal)) {
        return { ok: false, error: "aborted", message: messageOf(error) };
      }
      if (error instanceof ServerUnavailableError) {
        return { ok: false, error: "server_backoff", message: error.message };
      }
      return { ok: false, error: "connect_failed", message: messageOf(error) };
    }
  }

  /**
   * The tools of a server, connecting if nothing is known yet. Used before resolving a tool name
   * on a server that was never discovered.
   */
  async toolsOrConnect(
    server: string,
    signal?: AbortSignal,
  ): Promise<ConnectOutcome> {
    const known = this.tools(server);
    if (known !== undefined) return { ok: true, tools: known };
    return await this.connect(server, { signal });
  }

  /** Connects the keep-alive servers (they are reconnected whenever they drop from here on). */
  async start(signal?: AbortSignal): Promise<void> {
    await Promise.all(
      this.servers().map(async (definition) => {
        if (
          definition.disabled === true ||
          lifecycleOf(definition) !== "keep-alive"
        )
          return;
        this.host.manager.keep(this.owner, definition, this.cwd);
        await this.connect(definition.name, { signal, force: true });
      }),
    );
  }

  /**
   * Reads the tool list of every server that has no valid cache yet, a few at a time, so search
   * and direct tools have something to show. A lazy server is closed again as soon as its tools
   * are read; the keep-alive modes and `idleTimeout: 0` stay up. One cache write at the end.
   */
  async warmUp(options: WarmUpOptions = {}): Promise<WarmUpResult> {
    const cache = this.host.cacheFor(this.owner);
    const result: WarmUpResult = { discovered: [], failed: {}, needsAuth: [] };
    const pending = this.servers().filter(
      (definition) =>
        definition.disabled !== true &&
        cache.get(definition.name, definition.hash) === undefined &&
        !cache.discoveryFailed(definition.name, definition.hash),
    );
    const updates: Record<string, Omit<ServerCacheEntry, "cachedAt">> = {};
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const definition = pending[next++];
        if (!definition || options.signal?.aborted === true) return;
        try {
          // A connection that was already up belongs to whoever opened it.
          const alreadyUp =
            this.host.manager.get(this.owner, definition.name)?.status ===
            "connected";
          const connection = await this.host.manager.connect(
            this.owner,
            definition,
            {
              signal: options.signal,
              hooks: this.hooks,
              cwd: this.cwd,
              force: true,
            },
          );
          if (connection.status === "needs-auth") {
            result.needsAuth.push(definition.name);
            continue;
          }
          updates[definition.name] = this.host.entryOf(connection);
          result.discovered.push(definition.name);
          const keepOpen =
            lifecycleOf(definition) !== "lazy" || definition.idleTimeout === 0;
          // Only a connection this warm-up opened, and nobody joined, is its to close; the rest is
          // in use (or about to be) and is left to the idle check.
          if (
            !keepOpen &&
            !alreadyUp &&
            !this.host.manager.wasJoined(this.owner, definition.name)
          )
            await this.host.manager.close(this.owner, definition.name);
        } catch (error) {
          if (isAbort(error, options.signal)) return;
          result.failed[definition.name] = messageOf(error);
          updates[definition.name] = {
            configHash: definition.hash,
            tools: [],
            discoveryFailed: true,
          };
        }
      }
    };
    const workers = Math.min(
      options.concurrency ?? DEFAULT_WARM_CONCURRENCY,
      pending.length,
    );
    await Promise.all(Array.from({ length: workers }, worker));
    if (Object.keys(updates).length > 0) cache.save(updates);
    // A warm-up that failed leaves no failure record: the next explicit use should still try.
    for (const name of Object.keys(result.failed)) {
      this.host.manager.failures.clear(
        this.host.manager.failureKey(this.owner, name),
      );
    }
    this.emit();
    return result;
  }

  /** Stops tracking this scope. Connections are shared and stay; close them with the manager. */
  dispose(): void {
    this.listeners.clear();
    this.host.unregister(this);
  }

  // ---- calling ------------------------------------------------------------------------------

  private failureResult(
    code: string,
    text: string,
    server: string,
    tool: string,
    extra: Record<string, unknown> = {},
  ): McpToolResult {
    return {
      content: [{ type: "text", text }],
      isError: true,
      details: {
        mode: "call",
        error: code,
        server,
        tool,
        name: qualifiedToolName(server, tool),
        ...extra,
      },
    };
  }

  /**
   * Runs one tool call: argument check, the caller's veto and approval hooks, a lazy connection,
   * the request and result validation. Returns a result for every failure
   * (with `delivery` where the outcome of the request matters); aborts are returned too.
   */
  async callTool(
    server: string,
    tool: ToolMeta,
    args: Record<string, unknown>,
    context: McpExecuteContext = {},
  ): Promise<McpToolResult> {
    // In flight from the start, so an idle check cannot close the server while an approval is
    // waiting for the user.
    const held = this.connection(server);
    if (held) held.inFlight++;
    try {
      return await this.run(server, tool, args, context);
    } finally {
      if (held) held.inFlight--;
    }
  }

  private async run(
    server: string,
    tool: ToolMeta,
    args: Record<string, unknown>,
    context: McpExecuteContext,
  ): Promise<McpToolResult> {
    const definition = this.definitions.get(server);
    if (!definition) {
      return this.failureResult(
        "server_not_found",
        `Server "${server}" not found.`,
        server,
        tool.name,
      );
    }
    if (definition.disabled === true) {
      return this.failureResult(
        "server_disabled",
        `Server "${server}" is disabled.`,
        server,
        tool.name,
      );
    }
    const { signal } = context;
    const name = qualifiedToolName(server, tool.name);

    const invalid = schemaViolation(tool.inputSchema, args);
    if (invalid !== undefined)
      return await this.invalidArguments(server, tool, invalid);

    try {
      const veto = await this.hooks.onToolCall?.({
        name,
        server,
        tool: tool.name,
        args,
        toolCallId: context.toolCallId,
      });
      if (veto && typeof veto === "object" && "block" in veto) {
        return this.failureResult(
          "blocked",
          `MCP tool "${name}" was blocked: ${veto.block}`,
          server,
          tool.name,
          { delivery: "not_sent" satisfies McpDelivery, reason: veto.block },
        );
      }
    } catch (error) {
      if (isAbort(error, signal)) return this.aborted(server, tool.name);
      return this.failureResult(
        "blocked",
        `MCP tool "${name}" was blocked: ${messageOf(error)}`,
        server,
        tool.name,
        { delivery: "not_sent" satisfies McpDelivery },
      );
    }

    // `approveTools` is parsed but no longer gates a call: MCP tools run without approval.
    return await this.send(definition, tool, args, context);
  }

  private aborted(server: string, tool: string): McpToolResult {
    return this.failureResult(
      "aborted",
      `MCP tool "${tool}" on server "${server}" was cancelled.`,
      server,
      tool,
      {
        delivery: "not_sent" satisfies McpDelivery,
      },
    );
  }

  private async invalidArguments(
    server: string,
    tool: ToolMeta,
    reason: string,
  ): Promise<McpToolResult> {
    return {
      content: [
        {
          type: "text",
          text: `Failed to call tool: ${reason}\n\nInput schema:\n${JSON.stringify(tool.inputSchema, null, 2)}`,
        },
      ],
      isError: true,
      details: {
        mode: "call",
        error: "call_failed",
        delivery: "not_sent" satisfies McpDelivery,
        server,
        tool: tool.name,
        name: qualifiedToolName(server, tool.name),
        message: reason,
      },
    };
  }

  private async send(
    definition: McpServerDefinition,
    requested: ToolMeta,
    args: Record<string, unknown>,
    context: McpExecuteContext,
  ): Promise<McpToolResult> {
    const server = definition.name;
    const { signal } = context;
    const manager = this.host.manager;
    let tool = requested;

    let connection: Connection;
    const connect = async (): Promise<Connection | McpToolResult> => {
      try {
        const connected = await manager.connect(this.owner, definition, {
          signal,
          hooks: this.hooks,
          cwd: this.cwd,
        });
        if (connected.status === "needs-auth") {
          return this.failureResult(
            "auth_required",
            `Server "${server}" requires authentication: ${connected.authMessage ?? "sign-in is required"}.`,
            server,
            tool.name,
            {
              delivery: "not_sent" satisfies McpDelivery,
              message: connected.authMessage,
            },
          );
        }
        this.persist(connected);
        return connected;
      } catch (error) {
        if (isAbort(error, signal)) return this.aborted(server, tool.name);
        if (error instanceof ServerUnavailableError) {
          return this.failureResult(
            "server_backoff",
            error.message,
            server,
            tool.name,
            {
              delivery: "not_sent" satisfies McpDelivery,
            },
          );
        }
        return this.failureResult(
          "connect_failed",
          `Failed to connect to "${server}": ${messageOf(error)}`,
          server,
          tool.name,
          {
            delivery: "not_sent" satisfies McpDelivery,
            message: messageOf(error),
          },
        );
      }
    };

    const first = await connect();
    if (!("status" in first)) return first;
    connection = first;

    // The cache may be stale: the live definition decides what is called and validated.
    const live = connection.tools.find(
      (candidate) => candidate.name === requested.name,
    );
    if (!live) {
      return this.failureResult(
        "tool_not_found_after_connect",
        `Tool "${requested.name}" is not offered by server "${server}" (its tools changed).`,
        server,
        requested.name,
        { delivery: "not_sent" satisfies McpDelivery },
      );
    }
    tool = live;
    if (live.inputSchema !== requested.inputSchema) {
      const invalid = schemaViolation(live.inputSchema, args);
      if (invalid !== undefined)
        return await this.invalidArguments(server, live, invalid);
    }

    let sent = false;
    const attempt = async (): Promise<
      Awaited<ReturnType<ServerManager["callTool"]>>
    > => {
      const hadSession = connection.sessionId !== undefined;
      try {
        return await manager.use(connection, async () => {
          sent = true;
          return await manager.callTool(
            connection,
            { name: tool.name, arguments: args },
            signal,
          );
        });
      } catch (error) {
        // The server forgot the session, or the connection dropped before the request left: the call
        // did not run, so one fresh connection and one more try cannot double it.
        const notSent =
          isTerminatedSession(error, hadSession) ||
          (error instanceof SdkError &&
            error.code === SdkErrorCode.NotConnected);
        if (!notSent || signal?.aborted === true) throw error;
        sent = false;
        await manager.close(this.owner, server);
        const again = await connect();
        if (!("status" in again))
          throw new DeliveryError("not_sent", "could not reconnect", {
            cause: error,
          });
        connection = again;
        return await manager.use(connection, async () => {
          sent = true;
          return await manager.callTool(
            connection,
            { name: tool.name, arguments: args },
            signal,
          );
        });
      }
    };

    let result: Awaited<ReturnType<ServerManager["callTool"]>>;
    try {
      result = await attempt();
    } catch (error) {
      if (isAbort(error, signal)) {
        return sent
          ? this.deliveryFailure(
              server,
              tool,
              new DeliveryError(
                "may_have_run",
                "the call was cancelled while running",
                { cause: error },
              ),
              "aborted",
            )
          : this.aborted(server, tool.name);
      }
      return this.deliveryFailure(server, tool, classifyCallError(error));
    }

    return await this.finish(server, tool, result);
  }

  private deliveryFailure(
    server: string,
    tool: ToolMeta,
    error: DeliveryError,
    code = "call_failed",
  ): McpToolResult {
    const text = describeDelivery(error, server, tool.name);
    return {
      content: [{ type: "text", text }],
      isError: true,
      details: {
        mode: "call",
        error: code,
        delivery: error.delivery,
        server,
        tool: tool.name,
        name: qualifiedToolName(server, tool.name),
        message: error.message,
        ...(error.protocolCode === undefined
          ? {}
          : { protocolCode: error.protocolCode }),
      },
    };
  }

  /** Turns a server's answer into the result the model sees. */
  private async finish(
    server: string,
    tool: ToolMeta,
    result: {
      content?: unknown;
      structuredContent?: unknown;
      isError?: boolean;
      _meta?: unknown;
    },
  ): Promise<McpToolResult> {
    const name = qualifiedToolName(server, tool.name);
    const identity = { mode: "call", server, tool: tool.name, name };

    if (result.isError !== true && tool.outputSchema !== undefined) {
      const violation =
        result.structuredContent === undefined
          ? "the result has no structuredContent"
          : schemaViolation(tool.outputSchema, result.structuredContent);
      if (violation !== undefined) {
        return this.deliveryFailure(
          server,
          tool,
          new DeliveryError(
            "invalid_result",
            `structured content does not match the tool's output schema: ${violation}`,
          ),
        );
      }
    }

    const content = resultContent(result);
    const meta = result._meta === undefined ? {} : { _meta: result._meta };
    if (result.isError === true) {
      return {
        content:
          content.length > 0
            ? content
            : [{ type: "text", text: "(empty result)" }],
        isError: true,
        details: { ...identity, error: "tool_error", ...meta },
      };
    }

    if (tool.outputSchema === undefined) {
      const observed = this.observed(server);
      const before = JSON.stringify(observed.get(tool.name));
      const key = outputShapeKey(tool);
      recordObservedOutput(
        observed,
        tool.name,
        key,
        result as Record<string, unknown>,
      );
      if (JSON.stringify(observed.get(tool.name)) !== before) {
        const connection = this.connection(server);
        if (connection) this.persist(connection);
      }
    }

    return {
      content:
        content.length > 0
          ? content
          : [{ type: "text", text: "(empty result)" }],
      details: {
        ...identity,
        ...meta,
        ...(result.structuredContent === undefined
          ? {}
          : { structuredContent: result.structuredContent }),
      },
    };
  }

  /** The shape seen for a tool, if any (for `describe`). */
  observedFor(
    server: string,
    tool: ToolMeta,
  ): ReturnType<typeof getObservedOutput> {
    return getObservedOutput(this.observed(server), tool);
  }
}

/**
 * The text and image blocks of a result. Other content becomes text; `structuredContent` follows
 * the content when both are present and stands in when there is no content.
 */
export function resultContent(result: {
  content?: unknown;
  structuredContent?: unknown;
}): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const raw of Array.isArray(result.content) ? result.content : []) {
    const block = raw as Record<string, unknown>;
    if (block.type === "text") {
      blocks.push({
        type: "text",
        text: typeof block.text === "string" ? block.text : "",
      });
    } else if (block.type === "image") {
      blocks.push({
        type: "image",
        data: typeof block.data === "string" ? block.data : "",
        mimeType:
          typeof block.mimeType === "string" ? block.mimeType : "image/png",
      });
    } else if (block.type === "resource") {
      const resource = (block.resource ?? {}) as Record<string, unknown>;
      const uri = typeof resource.uri === "string" ? resource.uri : "(no URI)";
      const body =
        typeof resource.text === "string"
          ? resource.text
          : typeof resource.blob === "string"
            ? `[binary ${typeof resource.mimeType === "string" ? resource.mimeType : "data"}, ${resource.blob.length} base64 characters]`
            : "(no content)";
      blocks.push({ type: "text", text: `[Resource: ${uri}]\n${body}` });
    } else if (block.type === "resource_link") {
      blocks.push({
        type: "text",
        text: `[Resource Link: ${String(block.name ?? block.uri ?? "unknown")}]\nURI: ${String(block.uri ?? "(no URI)")}`,
      });
    } else if (block.type === "audio") {
      blocks.push({
        type: "text",
        text: `[Audio content: ${String(block.mimeType ?? "audio/*")}]`,
      });
    } else {
      blocks.push({ type: "text", text: JSON.stringify(block) });
    }
  }
  if (
    result.structuredContent !== undefined &&
    result.structuredContent !== null
  ) {
    const structured =
      JSON.stringify(result.structuredContent, null, 2) ??
      String(result.structuredContent);
    if (blocks.length > 0)
      blocks.push({ type: "text", text: `structuredContent:\n${structured}` });
    else blocks.push({ type: "text", text: structured });
  }
  return blocks;
}
