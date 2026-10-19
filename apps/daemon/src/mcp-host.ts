/**
 * MCP on one machine: the primary's, or a daemon's.
 *
 * Each machine runs one `McpManager` (the library's connections, metadata cache and output guard,
 * all under this machine's state directory) and gives every session a scope of it. The scope is
 * keyed by the agent, so every session of one agent on this machine shares the agent's
 * connections; two agents never do. A stdio server is a child process of the machine the session
 * runs on.
 *
 * What a session is given: the `mcp` proxy tool, and the direct tools its servers declare
 * (`directTools`), from the metadata cache. Nothing connects until a call, and a server that has
 * no cache yet is read once in the background, so opening a session never waits for a server.
 *
 * Where a session's servers are declared, later overriding earlier by name: the bundles the
 * agent loads (their `mcp.json`), the user's `~/.eta/mcp.json`, and the `.mcp.json` of the
 * session's working directory (loaded as it is: the user put it in their project).
 *
 * The hooks that make the library part of the product are built here from the session:
 * `approve` and `elicit` are questions on the session's ask channel (a card in the inbox, wherever
 * the session runs), and `onToolCall` is akhook's tool middleware asked about `mcp__<server>__<tool>`.
 */
import type { KernelTool, ToolMiddleware } from "@eta/core";
import type { OpenSession } from "@eta/harness";
import type {
  AuthProviderFor,
  ElicitationRequest,
  ElicitationResponse,
  McpConfigSource,
  McpHooks,
  McpManagerOptions,
  McpScope,
  McpToolDefinition,
} from "@eta/mcp";
import type { SessionMeta } from "@eta/server";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createDirectTools,
  createProxyTool,
  McpManager,
  parseMcpServers,
} from "@eta/mcp";
import { registerSessionTools } from "@eta/server";

/** How long an agent's connections outlive its last session on this machine. */
const DEFAULT_GRACE_MS = 60_000;
/** The most of a call's arguments an approval question shows. */
const MAX_ARGUMENTS = 500;
const ALLOW = "allow";
const DENY = "deny";
/** The owner of sessions that belong to no agent. */
const BARE = "session";

export interface McpHostOptions {
  /** This machine's state directory: the cache, resolutions and saved outputs go under `mcp/`. */
  dataDir: string;
  /** The user's home on this machine: `~/.eta/mcp.json` is under it. */
  home: string;
  warn: (message: string) => void;
  /** OAuth for `auth: "oauth"` servers; without it such a server reports it needs sign-in. */
  authProviderFor?: AuthProviderFor | undefined;
  /** The fetch of HTTP transports and their token requests. */
  fetch?: McpManagerOptions["fetch"] | undefined;
  /** How long an agent's connections are kept after its last session here closes. */
  graceMs?: number | undefined;
  /** Overrides of the library's manager (a test turns the timers and launch resolution off). */
  manager?: Partial<McpManagerOptions> | undefined;
}

/** What differs from session to session in the sources. */
export interface McpSessionInput {
  meta: SessionMeta;
  session: OpenSession;
  /** The agent's bundles' servers, one source per bundle. */
  bundles: readonly McpConfigSource[];
  /** akhook's tool-call checks for this session; MCP calls are asked about as `mcp__<server>__<tool>`. */
  akhook?: ToolMiddleware | undefined;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Read one `mcp.json`; a missing file is no servers and a broken one is a warning. */
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

/**
 * The sources of a session, in the order that decides which wins a clash: the bundles', the
 * user's global file, and the project's.
 */
export function mcpSources(options: {
  home: string;
  cwd: string | undefined;
  bundles: readonly McpConfigSource[];
  warn: (message: string) => void;
}): McpConfigSource[] {
  const { home, cwd, bundles, warn } = options;
  const files: [string, string][] = [
    ["~/.eta/mcp.json", join(home, ".eta", "mcp.json")],
    ...(cwd === undefined
      ? []
      : [[".mcp.json", join(cwd, ".mcp.json")] as [string, string]]),
  ];
  return [
    ...bundles,
    ...files.flatMap(([name, path]) => {
      const source = readSource(name, path, warn);
      return source === undefined ? [] : [source];
    }),
  ].filter((source) => Object.keys(source.servers).length > 0);
}

const cut = (text: string): string =>
  text.length <= MAX_ARGUMENTS ? text : `${text.slice(0, MAX_ARGUMENTS)}...`;

/** A question of the ask channel gets its answer as selection or text; this reads either. */
function chosen(
  response: Awaited<ReturnType<NonNullable<OpenSession["ask"]>["ask"]>>,
): string | undefined {
  if (response.kind === "selection") return response.selections[0];
  if (response.kind === "freeform") return response.text.trim();
  return undefined;
}

interface Field {
  key: string;
  label: string;
  required: boolean;
  kind: "text" | "number" | "boolean" | "choice";
  choices: { value: string; label: string }[];
}

/** The fields of a flat form, or why it cannot be asked as questions. */
function fieldsOf(schema: unknown): Field[] | string {
  if (typeof schema !== "object" || schema === null)
    return "the form has no schema";
  const { properties, required } = schema as {
    properties?: unknown;
    required?: unknown;
  };
  if (typeof properties !== "object" || properties === null)
    return "the form has no fields";
  const needed = new Set(Array.isArray(required) ? required : []);
  const fields: Field[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    const prop = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
      string,
      unknown
    >;
    const label =
      typeof prop.title === "string" && prop.title !== "" ? prop.title : key;
    const base = {
      key,
      label:
        typeof prop.description === "string" && prop.description !== ""
          ? `${label}: ${prop.description}`
          : label,
      required: needed.has(key),
    };
    if (
      Array.isArray(prop.enum) &&
      prop.enum.every((v) => typeof v === "string")
    ) {
      const names = Array.isArray(prop.enumNames) ? prop.enumNames : [];
      fields.push({
        ...base,
        kind: "choice",
        choices: (prop.enum as string[]).map((value, index) => ({
          value,
          label: typeof names[index] === "string" ? names[index] : value,
        })),
      });
    } else if (prop.type === "string" && prop.oneOf === undefined) {
      fields.push({ ...base, kind: "text", choices: [] });
    } else if (prop.type === "number" || prop.type === "integer") {
      fields.push({ ...base, kind: "number", choices: [] });
    } else if (prop.type === "boolean") {
      fields.push({ ...base, kind: "boolean", choices: [] });
    } else {
      return `the field "${key}" is not a string, number, boolean or choice`;
    }
  }
  return fields;
}

/** A tool of the library as a kernel tool; what the model's turn needs is the same four things. */
function kernelTool(
  definition: McpToolDefinition,
  notes: string[],
): KernelTool & { parameters: unknown } {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    async execute(args: unknown, call) {
      notes.length = 0;
      const result = await definition.execute(args, {
        toolCallId: call.toolCallId,
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      });
      // What the model has to know about the form the server asked mid-call and could not be shown.
      if (notes.length === 0) return result;
      const added = notes.splice(0).map((text) => ({ type: "text", text }));
      return { ...result, content: [...result.content, ...added] };
    },
  };
}

export class McpHost {
  readonly manager: McpManager;
  readonly #options: McpHostOptions;
  /** The live scopes of each owner on this machine. */
  readonly #live = new Map<string, Set<McpScope>>();
  readonly #closing = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #inspectors = new Map<string, McpScope>();
  /** The agent's warm-up in progress, so warm-ups of its sessions run one after another. */
  readonly #warming = new Map<string, Promise<unknown>>();

  constructor(options: McpHostOptions) {
    this.#options = options;
    const root = join(options.dataDir, "mcp");
    this.manager = new McpManager({
      cacheFile: (owner) =>
        join(root, "cache", `${encodeURIComponent(owner)}.json`),
      outputDir: join(root, "outputs"),
      resolverCacheFile: join(root, "resolvers.json"),
      ...(options.authProviderFor === undefined
        ? {}
        : { authProviderFor: options.authProviderFor }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...options.manager,
    });
  }

  /** The sources a session of this agent here would get. */
  sourcesFor(
    cwd: string | undefined,
    bundles: readonly McpConfigSource[],
  ): McpConfigSource[] {
    return mcpSources({
      home: this.#options.home,
      cwd,
      bundles,
      warn: this.#options.warn,
    });
  }

  /**
   * A scope that no session holds, for a status page: what an agent's servers are and how they
   * stand, from the sources a new session would get. It shares the owner's connections and cache.
   */
  inspect(owner: string, sources: readonly McpConfigSource[]): McpScope {
    const found = this.#inspectors.get(owner);
    if (found !== undefined) {
      found.setSources(sources);
      return found;
    }
    const scope = this.manager.scope({ owner, sources });
    this.#inspectors.set(owner, scope);
    return scope;
  }

  /** The live scopes, for a status page. */
  scopes(): { owner: string; scope: McpScope }[] {
    return [...this.#live].flatMap(([owner, scopes]) =>
      [...scopes].map((scope) => ({ owner, scope })),
    );
  }

  /**
   * A session's MCP tools: the proxy and the direct ones. Synchronous, because the session
   * manager's hook is; the servers are not touched. The scope goes with the session.
   */
  sessionTools(input: McpSessionInput): KernelTool[] {
    const { meta, session } = input;
    const sources = this.sourcesFor(meta.cwd, input.bundles);
    if (sources.length === 0) return [];
    const owner = meta.agentId ?? BARE;
    const notes: string[] = [];
    const scope = this.manager.scope({
      owner,
      sources,
      cwd: meta.cwd,
      hooks: this.#hooks(input, notes),
    });
    this.#track(owner, scope);

    const registered = new Set<string>();
    const toolsOf = (): KernelTool[] =>
      [createProxyTool(scope), ...createDirectTools(scope)]
        .filter((definition) => !registered.has(definition.name))
        .map((definition) => {
          registered.add(definition.name);
          return kernelTool(definition, notes);
        });

    let closed = false;
    // A server that has never been read has no direct tools to offer yet: read it once in the
    // background and add what it declares. The proxy finds its tools without any of this.
    // One at a time per agent: a second session opening meanwhile finds the cache the first filled.
    const warming = (this.#warming.get(owner) ?? Promise.resolve())
      .then(() => (closed ? undefined : scope.warmUp()))
      .finally(() => {
        if (this.#warming.get(owner) === warming) this.#warming.delete(owner);
      });
    this.#warming.set(owner, warming);
    void warming
      .then(() => {
        if (closed) return;
        const added = toolsOf();
        if (added.length > 0) registerSessionTools(session, added);
      })
      .catch((error: unknown) =>
        this.#options.warn(`[eta] MCP warm-up: ${messageOf(error)}`),
      );
    void scope.start().catch(() => undefined);

    session.kernel.ctx.effect(() => () => {
      closed = true;
      this.#release(owner, scope);
    });
    return toolsOf();
  }

  #track(owner: string, scope: McpScope): void {
    const pending = this.#closing.get(owner);
    if (pending !== undefined) clearTimeout(pending);
    this.#closing.delete(owner);
    let scopes = this.#live.get(owner);
    if (scopes === undefined) this.#live.set(owner, (scopes = new Set()));
    scopes.add(scope);
  }

  /** The last session of an agent here is gone: keep its connections a while, then close them. */
  #release(owner: string, scope: McpScope): void {
    scope.dispose();
    const scopes = this.#live.get(owner);
    scopes?.delete(scope);
    if (scopes === undefined || scopes.size > 0) return;
    this.#live.delete(owner);
    const timer = setTimeout(() => {
      this.#closing.delete(owner);
      void this.manager.closeOwner(owner);
    }, this.#options.graceMs ?? DEFAULT_GRACE_MS);
    timer.unref();
    this.#closing.set(owner, timer);
  }

  #hooks(input: McpSessionInput, notes: string[]): McpHooks {
    const { session, akhook } = input;
    const ask = (
      questionId: string,
      question: string,
      options: string[] | undefined,
      signal: AbortSignal | undefined,
    ) =>
      session.ask === undefined
        ? undefined
        : session.ask.ask(
            {
              questionId,
              question,
              ...(options === undefined ? {} : { options }),
            },
            signal === undefined ? {} : { signal },
          );
    return {
      approve: async (request) => {
        const shown = cut(JSON.stringify(request.args) ?? "");
        const response = await ask(
          `${request.toolCallId ?? randomUUID()}:mcp-approve`,
          `Run the \`${request.name}\` MCP tool${shown === "" || shown === "{}" ? "" : ` with ${shown}`}?`,
          [ALLOW, DENY],
          request.signal,
        );
        return response !== undefined && chosen(response) === ALLOW;
      },
      elicit: (request) => this.#elicit(request, ask, notes),
      ...(akhook?.before === undefined
        ? {}
        : {
            onToolCall: async (call) => {
              const verdict = await akhook.before!(call.name, call.args, {
                turn: 0,
                // The question (if the rules ask) is the call's own, not the `mcp` tool's.
                toolCallId: `${call.toolCallId ?? randomUUID()}:mcp`,
              });
              if (!verdict.ok) return { block: verdict.blockReason };
              return undefined;
            },
          }),
    };
  }

  /**
   * A server's form as questions, one per field: a choice is its options, a boolean is yes or no,
   * text and numbers are free text. A form that is not that flat is cancelled, and the model is
   * told why on the call's result (the server only learns that it was cancelled).
   */
  async #elicit(
    request: ElicitationRequest,
    ask: (
      id: string,
      question: string,
      options: string[] | undefined,
      signal: AbortSignal | undefined,
    ) => ReturnType<NonNullable<OpenSession["ask"]>["ask"]> | undefined,
    notes: string[],
  ): Promise<ElicitationResponse> {
    const { server, params, signal } = request;
    const cancel = (reason: string): ElicitationResponse => {
      notes.push(
        `MCP server ${server} asked for input that could not be shown, so the request was cancelled: ${reason}.`,
      );
      return { action: "cancel" };
    };
    if (params.mode === "url") return cancel("it is a request to open a URL");
    const message =
      typeof params.message === "string" ? params.message : "Input requested";
    const fields = fieldsOf(params.requestedSchema);
    if (typeof fields === "string") return cancel(fields);
    const header = `${server}: ${message}`;

    const content: Record<string, string | number | boolean> = {};
    for (const field of fields) {
      const optional = field.required ? "" : " (optional, answer - to skip)";
      const options =
        field.kind === "choice"
          ? field.choices.map((choice) => choice.value)
          : field.kind === "boolean"
            ? ["yes", "no"]
            : undefined;
      const response = await ask(
        `elicit-${randomUUID()}`,
        `${header}\n${field.label}${optional}`,
        options,
        signal,
      );
      if (response === undefined)
        return cancel("this session has no one to ask");
      const answer = chosen(response);
      // Nobody answered, or the user said no: that is a decline, unless the run itself ended.
      if (answer === undefined)
        return signal?.aborted === true
          ? { action: "cancel" }
          : { action: "decline" };
      if (!field.required && answer === "-") continue;
      if (field.kind === "boolean") content[field.key] = answer === "yes";
      else if (field.kind === "number") {
        const number = Number(answer);
        if (answer === "" || !Number.isFinite(number))
          return cancel(`"${answer}" is not a number for ${field.key}`);
        content[field.key] = number;
      } else if (field.kind === "choice") {
        if (!field.choices.some((choice) => choice.value === answer))
          return cancel(
            `"${answer}" is not one of the choices for ${field.key}`,
          );
        content[field.key] = answer;
      } else content[field.key] = answer;
    }
    return { action: "accept", content };
  }

  /** Close every connection (the machine is shutting down). */
  async close(): Promise<void> {
    for (const timer of this.#closing.values()) clearTimeout(timer);
    this.#closing.clear();
    this.#live.clear();
    await this.manager.closeAll();
  }
}
