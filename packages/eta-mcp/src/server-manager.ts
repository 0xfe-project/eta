// Ported from pi-mcp-adapter/server-manager.ts, lifecycle.ts and elicitation-handler.ts (MIT, see ../NOTICE); one manager keyed by owner and server, without OAuth flows, resources, prompts, tasks, tracing or UI streams.
/**
 * Connections to MCP servers, shared by everyone who uses the same owner.
 *
 * An owner is the caller's isolation key (an agent's id, say): the same owner and server name share
 * one connection however many sessions use them, and two owners never share one. A server is
 * connected when first used, closed after it sits idle, and connected again on the next use. The
 * keep-alive lifecycles stay up and are reconnected when they drop.
 *
 * Failures are remembered: a server that could not be reached fails fast for a minute rather than
 * making every call wait for another doomed attempt.
 */
import type {
  OAuthClientProvider,
  Transport,
} from "@modelcontextprotocol/client";
import type { ResolverEnv } from "./launch";
import type {
  AuthProviderFor,
  McpHooks,
  McpServerDefinition,
  ToolAnnotations,
  ToolMeta,
} from "./types";
import { Buffer } from "node:buffer";
import process from "node:process";
import {
  Client,
  DEFAULT_REQUEST_TIMEOUT_MSEC,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { interpolateEnv, lifecycleOf, resolveBearerToken } from "./config";
import { FailureTracker } from "./failure-backoff";
import { createJsonSchemaValidator } from "./json-schema";
import { resolveLaunch } from "./launch";

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_IDLE_CHECK_MS = 30 * 1000;
const KEEP_ALIVE_RETRY_BASE_MS = 30 * 1000;
const KEEP_ALIVE_RETRY_MAX_MS = 5 * 60 * 1000;
const MAX_CAPTURED_STDERR_BYTES = 8 * 1024;
// setTimeout fires immediately for delays above this.
const MAX_TIMER_MS = 2 ** 31 - 1;
const CLIENT_INFO = { name: "eta", version: "0.1.0" };

export interface ManagerOptions {
  /** Idle shutdown for lazy servers, in milliseconds. Default 10 minutes; 0 turns it off. */
  idleTimeoutMs?: number;
  /** How often idle and keep-alive checks run. Default 30 s; 0 runs none (call `sweep`). */
  checkIntervalMs?: number;
  now?: () => number;
  /** Hooks used when a call brings none of its own. */
  hooks?: McpHooks;
  authProviderFor?: AuthProviderFor;
  /** Variables for `${NAME}` in configs, and the base of a child's environment when it inherits. */
  env?: NodeJS.ProcessEnv;
  /** Launch acceleration (npx, bunx, uvx → the installed executable). `false` starts commands as written. */
  resolvers?: ResolverEnv | false;
  requestTimeoutMs?: number;
}

export type ConnectionStatus = "connected" | "closed" | "needs-auth";

export interface Connection {
  readonly key: string;
  readonly owner: string;
  definition: McpServerDefinition;
  client: Client | undefined;
  status: ConnectionStatus;
  /** Why the server needs sign-in, when it does. */
  authMessage: string | undefined;
  /** The server's tools, before include/exclude filtering. */
  tools: ToolMeta[];
  instructions: string | undefined;
  lastUsedAt: number;
  inFlight: number;
  /** Hooks of the caller that used this connection last; server-initiated requests go to them. */
  hooks: McpHooks;
  /** The transport's session id, if it has one (streamable HTTP). */
  sessionId: string | undefined;
}

export class ServerUnavailableError extends Error {
  readonly server: string;
  readonly detail: string;

  constructor(server: string, detail: string) {
    super(`Server "${server}" not available (last ${detail})`);
    this.name = "ServerUnavailableError";
    this.server = server;
    this.detail = detail;
  }
}

export interface ConnectOptions {
  signal?: AbortSignal | undefined;
  hooks?: McpHooks | undefined;
  /** The directory a stdio server starts in when its config names none. */
  cwd?: string | undefined;
  /** Ignore the failure backoff (an explicit `connect`). */
  force?: boolean;
}

interface Wanted {
  definition: McpServerDefinition;
  cwd: string | undefined;
  attempts: number;
  nextAttemptAt: number;
}

function keyOf(owner: string, name: string): string {
  return `${owner}\u0000${name}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnauthorized(error: unknown): boolean {
  return (
    error instanceof UnauthorizedError ||
    (error instanceof SdkHttpError && error.status === 401)
  );
}

/** Only a definitive "this endpoint does not speak streamable HTTP" falls back to legacy SSE. */
function shouldFallBackToSse(error: unknown): boolean {
  return (
    error instanceof SdkHttpError && [404, 405, 406, 415].includes(error.status)
  );
}

function toolsOf(listed: Array<Record<string, unknown>>): ToolMeta[] {
  const tools: ToolMeta[] = [];
  for (const tool of listed) {
    if (typeof tool.name !== "string" || !tool.name) continue;
    const annotations = tool.annotations as ToolAnnotations | undefined;
    tools.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      ...(tool.inputSchema === undefined
        ? {}
        : { inputSchema: tool.inputSchema }),
      ...(tool.outputSchema === undefined
        ? {}
        : { outputSchema: tool.outputSchema }),
      ...(annotations ? { annotations: pickAnnotations(annotations) } : {}),
    });
  }
  return tools;
}

function pickAnnotations(annotations: ToolAnnotations): ToolAnnotations {
  const picked: ToolAnnotations = {};
  if (typeof annotations.title === "string") picked.title = annotations.title;
  for (const hint of [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ] as const) {
    if (typeof annotations[hint] === "boolean")
      picked[hint] = annotations[hint];
  }
  return picked;
}

/** Keeps the end of a child's stderr: what a failed start usually needs is the last lines. */
function appendTail(tail: Buffer, chunk: Buffer | string): Buffer {
  const merged = Buffer.concat([
    tail,
    typeof chunk === "string" ? Buffer.from(chunk) : chunk,
  ]);
  return merged.length > MAX_CAPTURED_STDERR_BYTES
    ? merged.subarray(merged.length - MAX_CAPTURED_STDERR_BYTES)
    : merged;
}

export class ServerManager {
  readonly failures: FailureTracker;
  private readonly connections = new Map<string, Connection>();
  private readonly connecting = new Map<string, Promise<Connection>>();
  private readonly wanted = new Map<string, Wanted>();
  private readonly listeners = new Set<ToolsChangedListener>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private readonly now: () => number;
  /** Open elicitation prompts per connection: their time does not count against a call's timeout. */
  private readonly prompts = new Map<Connection, PromptPause>();

  private readonly options: ManagerOptions;

  constructor(options: ManagerOptions = {}) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.failures = new FailureTracker(this.now);
  }

  /** Told when a connected server announces a changed tool list (after the list was re-read). */
  onToolsChanged(listener: ToolsChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(owner: string, name: string): Connection | undefined {
    return this.connections.get(keyOf(owner, name));
  }

  isConnecting(owner: string, name: string): boolean {
    return this.connecting.has(keyOf(owner, name));
  }

  failureKey(owner: string, name: string): string {
    return keyOf(owner, name);
  }

  /**
   * A live connection for the server, connecting (or reconnecting a closed one) when needed.
   * Concurrent callers share one attempt. A recent failure throws `ServerUnavailableError`
   * without trying again, unless `force` is set.
   */
  async connect(
    owner: string,
    definition: McpServerDefinition,
    options: ConnectOptions = {},
  ): Promise<Connection> {
    if (this.stopped) throw new Error("MCP manager is closed");
    if (definition.disabled === true) {
      throw new Error(`MCP server "${definition.name}" is disabled`);
    }
    const key = keyOf(owner, definition.name);
    const hooks = options.hooks ?? this.options.hooks ?? {};

    const existing = this.connections.get(key);
    if (
      existing?.status === "connected" &&
      existing.definition.hash === definition.hash
    ) {
      existing.hooks = hooks;
      existing.definition = definition;
      this.touch(existing);
      return existing;
    }
    const pending = this.connecting.get(key);
    if (pending) return await raceAbort(pending, options.signal);

    if (!options.force) {
      const failure = this.failures.describe(key);
      // A needs-auth server is retried: signing in is exactly what changes its answer.
      if (failure !== undefined && existing?.status !== "needs-auth") {
        throw new ServerUnavailableError(definition.name, failure);
      }
    }

    const attempt = (async (): Promise<Connection> => {
      // A changed config, or a dead connection: whatever is there goes first.
      if (existing) await this.dispose(existing);
      const connection = await this.open(owner, definition, hooks, options);
      if (this.stopped) {
        await this.dispose(connection);
        throw new Error("MCP manager is closed");
      }
      this.connections.set(key, connection);
      this.failures.clear(key);
      if (connection.status === "connected")
        this.afterConnect(connection, options.cwd);
      this.startTimer();
      return connection;
    })();
    this.connecting.set(key, attempt);
    try {
      return await raceAbort(attempt, options.signal);
    } catch (error) {
      if (options.signal?.aborted !== true) {
        this.failures.record(key, messageOf(error));
      }
      throw error;
    } finally {
      if (this.connecting.get(key) === attempt) this.connecting.delete(key);
      // A failed attempt nobody awaits must not become an unhandled rejection.
      attempt.catch(() => undefined);
    }
  }

  private afterConnect(connection: Connection, cwd: string | undefined): void {
    const lifecycle = lifecycleOf(connection.definition);
    if (lifecycle === "lazy") return;
    // keep-alive and lazy-keep-alive: reconnect when dropped, with a growing delay.
    this.wanted.set(connection.key, {
      definition: connection.definition,
      cwd,
      attempts: 0,
      nextAttemptAt: 0,
    });
  }

  /**
   * Marks a server as one to keep up (keep-alive) before its first use, so the next `sweep`
   * connects it. A lazy-keep-alive server joins on its first connection instead.
   */
  keep(owner: string, definition: McpServerDefinition, cwd?: string): void {
    if (this.stopped || definition.disabled === true) return;
    this.wanted.set(keyOf(owner, definition.name), {
      definition,
      cwd,
      attempts: 0,
      nextAttemptAt: 0,
    });
    this.startTimer();
  }

  /** Counts a call in flight so the idle check leaves the server alone, and keeps it fresh. */
  async use<T>(connection: Connection, run: () => Promise<T>): Promise<T> {
    connection.inFlight++;
    this.touch(connection);
    try {
      return await run();
    } finally {
      connection.inFlight--;
      this.touch(connection);
    }
  }

  touch(connection: Connection): void {
    connection.lastUsedAt = this.now();
  }

  async close(owner: string, name: string): Promise<void> {
    const key = keyOf(owner, name);
    this.wanted.delete(key);
    this.failures.clear(key);
    const connection = this.connections.get(key);
    if (connection) await this.dispose(connection);
    const pending = this.connecting.get(key);
    if (pending) {
      await pending.then(
        (connected) => this.dispose(connected),
        () => undefined,
      );
    }
  }

  async closeOwner(owner: string): Promise<void> {
    const prefix = `${owner}\u0000`;
    const names = [
      ...this.connections.keys(),
      ...this.connecting.keys(),
      ...this.wanted.keys(),
    ]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
    await Promise.all(
      [...new Set(names)].map((name) => this.close(owner, name)),
    );
  }

  /** Closes every connection and stops the timers. The manager cannot be used afterwards. */
  async closeAll(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.wanted.clear();
    const pending = [...this.connecting.values()];
    await Promise.all(
      pending.map((promise) =>
        promise.then(
          () => undefined,
          () => undefined,
        ),
      ),
    );
    await Promise.all(
      [...this.connections.values()].map((connection) =>
        this.dispose(connection),
      ),
    );
    this.connections.clear();
  }

  /**
   * One idle and keep-alive pass: closes lazy servers idle past their timeout (never one with a
   * call in flight), and reconnects keep-alive servers that are not connected. Runs on a timer;
   * exposed so it can be driven by hand.
   */
  async sweep(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    for (const connection of [...this.connections.values()]) {
      if (connection.status !== "connected" || connection.inFlight > 0)
        continue;
      if (lifecycleOf(connection.definition) !== "lazy") continue;
      const minutes = connection.definition.idleTimeout;
      const timeout =
        minutes === undefined
          ? (this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS)
          : minutes * 60_000;
      if (timeout > 0 && now - connection.lastUsedAt >= timeout) {
        await this.dispose(connection);
      }
    }
    for (const [key, wanted] of [...this.wanted]) {
      const connection = this.connections.get(key);
      if (connection?.status === "connected" || this.connecting.has(key))
        continue;
      if (connection?.status === "needs-auth" || now < wanted.nextAttemptAt)
        continue;
      const owner = key.slice(0, key.indexOf("\u0000"));
      try {
        await this.connect(owner, wanted.definition, {
          cwd: wanted.cwd,
          force: true,
        });
        wanted.attempts = 0;
      } catch {
        wanted.attempts++;
        wanted.nextAttemptAt =
          now +
          Math.min(
            KEEP_ALIVE_RETRY_BASE_MS * 2 ** Math.min(wanted.attempts - 1, 10),
            KEEP_ALIVE_RETRY_MAX_MS,
          );
      }
    }
  }

  private startTimer(): void {
    const interval = this.options.checkIntervalMs ?? DEFAULT_IDLE_CHECK_MS;
    if (this.timer || this.stopped || interval <= 0) return;
    this.timer = setInterval(
      () => void this.sweep().catch(() => undefined),
      interval,
    );
    this.timer.unref();
  }

  /** Closes a connection and forgets it, if it is still the current one. */
  private async dispose(connection: Connection): Promise<void> {
    connection.status = "closed";
    if (this.connections.get(connection.key) === connection) {
      this.connections.delete(connection.key);
    }
    this.prompts.delete(connection);
    const client = connection.client;
    connection.client = undefined;
    try {
      await client?.close();
    } catch {
      // Already gone.
    }
  }

  private async open(
    owner: string,
    definition: McpServerDefinition,
    hooks: McpHooks,
    options: ConnectOptions,
  ): Promise<Connection> {
    const connection: Connection = {
      key: keyOf(owner, definition.name),
      owner,
      definition,
      client: undefined,
      status: "connected",
      authMessage: undefined,
      tools: [],
      instructions: undefined,
      lastUsedAt: this.now(),
      inFlight: 0,
      hooks,
      sessionId: undefined,
    };
    if (definition.command !== undefined) {
      await this.openClient(
        connection,
        () => this.stdioTransport(definition, options.cwd, options.signal),
        options,
      );
    } else {
      await this.openHttp(connection, options);
    }
    return connection;
  }

  private async openHttp(
    connection: Connection,
    options: ConnectOptions,
  ): Promise<void> {
    const { definition } = connection;
    const environment = this.options.env ?? process.env;
    const url = new URL(interpolateEnv(definition.url ?? "", environment));
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(definition.headers ?? {})) {
      headers[name] = interpolateEnv(value, environment);
    }
    let authProvider: OAuthClientProvider | undefined;
    if (definition.auth === "oauth") {
      authProvider = this.options.authProviderFor?.(definition.name, {
        owner: connection.owner,
        server: definition.name,
        url: url.href,
      });
      if (!authProvider) {
        connection.status = "needs-auth";
        connection.authMessage =
          "this server needs OAuth sign-in, which is not available here";
        return;
      }
    } else if (definition.auth === "bearer") {
      const token = resolveBearerToken(definition, environment);
      if (!token) {
        throw new Error(
          `MCP server "${definition.name}" is set to bearer auth but has no token`,
        );
      }
      headers.Authorization = `Bearer ${token}`;
    }
    const transportOptions = {
      ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
      ...(authProvider ? { authProvider } : {}),
    };

    const kinds =
      definition.type === "sse"
        ? (["sse"] as const)
        : definition.type === undefined
          ? (["http", "sse"] as const)
          : (["http"] as const);
    for (const [index, kind] of kinds.entries()) {
      const make = (): Made => ({
        transport:
          kind === "http"
            ? new StreamableHTTPClientTransport(url, transportOptions)
            : new SSEClientTransport(url, transportOptions),
      });
      try {
        await this.openClient(connection, make, options);
        return;
      } catch (error) {
        if (isUnauthorized(error)) {
          connection.status = "needs-auth";
          connection.authMessage =
            definition.auth === "oauth"
              ? "OAuth sign-in is required"
              : 'the server rejected the credentials (HTTP 401); set auth to "oauth" or send a token';
          return;
        }
        if (index < kinds.length - 1 && shouldFallBackToSse(error)) continue;
        throw error;
      }
    }
  }

  private async stdioTransport(
    definition: McpServerDefinition,
    defaultCwd: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Made> {
    const environment = this.options.env ?? process.env;
    const base =
      definition.inheritEnv === true
        ? Object.fromEntries(
            Object.entries(environment).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          )
        : getDefaultEnvironment();
    const env = { ...base };
    for (const [name, value] of Object.entries(definition.env ?? {})) {
      env[name] = interpolateEnv(value, environment);
    }
    const args = (definition.args ?? []).map((arg) =>
      interpolateEnv(arg, environment),
    );
    const resolved =
      this.options.resolvers === false
        ? { command: definition.command ?? "", args }
        : await resolveLaunch(
            interpolateEnv(definition.command ?? "", environment),
            args,
            { env: environment, ...this.options.resolvers },
            signal,
          );
    const cwd =
      definition.cwd === undefined
        ? defaultCwd
        : interpolateEnv(definition.cwd, environment);
    const transport = new StdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      env,
      ...(cwd === undefined ? {} : { cwd }),
      stderr: "pipe",
    });
    let tail: Buffer = Buffer.alloc(0);
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      tail = appendTail(tail, chunk);
    });
    return { transport, stderr: () => tail.toString("utf8").trim() };
  }

  /**
   * Connects a client over the transport `make` builds and reads the server's tools. On failure the
   * client is closed again; a stdio child's last stderr lines are added to the message.
   */
  private async openClient(
    connection: Connection,
    make: () => Made | Promise<Made>,
    options: ConnectOptions,
  ): Promise<void> {
    const { transport, stderr = () => "" } = await make();
    const client = this.createClient(connection);
    const timeout = this.requestTimeout(connection.definition);
    try {
      await client.connect(transport, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(timeout === undefined ? {} : { timeout }),
      });
      const listed = await client.listTools(undefined, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(timeout === undefined ? {} : { timeout }),
      });
      connection.tools = toolsOf(
        listed.tools as unknown as Array<Record<string, unknown>>,
      );
      connection.instructions = client.getInstructions() || undefined;
      connection.client = client;
      connection.sessionId = (transport as { sessionId?: string }).sessionId;
      client.onclose = () => {
        if (connection.client === client) {
          connection.status = "closed";
          connection.client = undefined;
        }
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      const detail = stderr();
      if (detail && !isUnauthorized(error)) {
        throw new Error(`${messageOf(error)}\n${detail}`, { cause: error });
      }
      throw error;
    }
  }

  private createClient(connection: Connection): Client {
    const hasElicitation = connection.hooks.elicit !== undefined;
    const client = new Client(CLIENT_INFO, {
      jsonSchemaValidator: createJsonSchemaValidator(),
      ...(hasElicitation
        ? { capabilities: { elicitation: { form: {} } } }
        : {}),
      listChanged: {
        tools: {
          onChanged: (error: Error | null, tools: unknown[] | null) => {
            if (error || !tools || connection.client !== client) return;
            connection.tools = toolsOf(tools as Array<Record<string, unknown>>);
            for (const listener of this.listeners) listener(connection);
          },
        },
      },
    });
    if (hasElicitation) {
      client.setRequestHandler("elicitation/create", (request, context) =>
        this.handleElicitation(
          connection,
          request.params as unknown as Record<string, unknown>,
          context,
        ),
      );
    }
    return client;
  }

  private async handleElicitation(
    connection: Connection,
    params: Record<string, unknown>,
    context: unknown,
  ): Promise<
    | {
        action: "accept";
        content: Record<string, string | number | boolean | string[]>;
      }
    | { action: "decline" | "cancel" }
  > {
    const elicit = connection.hooks.elicit;
    if (!elicit) return { action: "cancel" };
    const pause = this.prompts.get(connection) ?? {
      open: 0,
      deadlines: new Set(),
    };
    this.prompts.set(connection, pause);
    if (pause.open++ === 0)
      for (const deadline of pause.deadlines) deadline.pause();
    try {
      const signal = (
        context as { mcpReq?: { signal?: AbortSignal } } | undefined
      )?.mcpReq?.signal;
      return await elicit({
        server: connection.definition.name,
        params,
        signal,
      });
    } catch {
      return { action: "cancel" };
    } finally {
      if (--pause.open === 0)
        for (const deadline of pause.deadlines) deadline.resume();
    }
  }

  private requestTimeout(definition: McpServerDefinition): number | undefined {
    const timeout =
      definition.requestTimeoutMs ?? this.options.requestTimeoutMs;
    return typeof timeout === "number" && timeout > 0 ? timeout : undefined;
  }

  /**
   * Calls a tool. The request timeout counts only the time the user is not answering an
   * elicitation prompt from this server: the SDK's own timer cannot be paused, so it is pushed out
   * of the way and the deadline here aborts the request with the same timeout error.
   */
  async callTool(
    connection: Connection,
    params: { name: string; arguments: Record<string, unknown> },
    signal: AbortSignal | undefined,
  ): Promise<Awaited<ReturnType<Client["callTool"]>>> {
    const client = connection.client;
    if (!client || connection.status !== "connected") {
      throw new SdkError(SdkErrorCode.NotConnected, "the connection is closed");
    }
    // Every call asks for progress, and each progress notification restarts the timeout.
    const base = { onprogress: () => undefined, resetTimeoutOnProgress: true };
    const timeout = Math.min(
      this.requestTimeout(connection.definition) ??
        DEFAULT_REQUEST_TIMEOUT_MSEC,
      MAX_TIMER_MS,
    );
    const pause = this.prompts.get(connection) ?? {
      open: 0,
      deadlines: new Set(),
    };
    this.prompts.set(connection, pause);

    const expired = new AbortController();
    let remaining = timeout;
    let startedAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline: Deadline = {
      pause() {
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
        remaining -= Date.now() - startedAt;
      },
      resume() {
        startedAt = Date.now();
        timer = setTimeout(
          () =>
            expired.abort(
              new SdkError(SdkErrorCode.RequestTimeout, "Request timed out", {
                timeout,
              }),
            ),
          Math.max(remaining, 0),
        );
      },
    };
    pause.deadlines.add(deadline);
    if (pause.open === 0) deadline.resume();
    try {
      return await client.callTool(params, {
        ...base,
        timeout: MAX_TIMER_MS,
        signal: signal
          ? AbortSignal.any([signal, expired.signal])
          : expired.signal,
        onprogress: () => {
          const running = timer !== undefined;
          deadline.pause();
          remaining = timeout;
          if (running) deadline.resume();
        },
      });
    } finally {
      pause.deadlines.delete(deadline);
      deadline.pause();
    }
  }
}

export type ToolsChangedListener = (connection: Connection) => void;

/** A transport ready to connect, and (for a child process) a way to read its last stderr lines. */
interface Made {
  transport: Transport;
  stderr?: () => string;
}

interface Deadline {
  pause: () => void;
  resume: () => void;
}

interface PromptPause {
  open: number;
  deadlines: Set<Deadline>;
}

/** Waits for `promise`, but gives up with the signal's reason when it aborts first. */
function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
