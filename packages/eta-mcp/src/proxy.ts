// Ported from pi-mcp-adapter/proxy-modes.ts and direct-tool-surface.ts#buildProxyDescription (MIT, see ../NOTICE); the same actions and wording, over plain scope methods instead of the Pi session state, and without install, auth, UI-message and semantic-search modes.
/**
 * The `mcp` tool: the one tool a model sees for every configured server.
 *
 * Context is the budget, so the description is small and fixed, and everything else is looked up on
 * demand: status, a server's tools, search, a tool's schema, a server's instructions, a call, a
 * connect. All of it except `call` and `connect` answers from the metadata cache without starting
 * a server.
 *
 * One call is one action; when several fields are given the first in this order wins:
 * `tool` (call), `connect`, `describe`, `instructions`, `search`, `server` (list), then status.
 */
import type { OutputGuardDetails, OutputGuardOptions } from "./output-guard";
import type { McpScope } from "./scope";
import type { SearchEntry } from "./search-ranking";
import type {
  McpExecuteContext,
  McpToolDefinition,
  McpToolResult,
  ServerStatus,
  ToolMeta,
} from "./types";
import { normalizeToolArguments } from "./json-schema";
import { findTools, qualifiedToolName } from "./names";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  guardText,
} from "./output-guard";
import { renderOutputShape } from "./output-shape";
import { requiresApproval } from "./scope";
import { paginate, rankTools, suggest } from "./search-ranking";
import { renderTsShape } from "./ts-shape";

export const PROXY_TOOL_NAME = "mcp";

const DEFAULT_SEARCH_LIMIT = 12;
const MAX_REGEX_SEARCH_QUERY_LENGTH = 256;
const INSTRUCTIONS_PREVIEW_LENGTH = 300;
const SUGGESTIONS = 5;

const PARAMETERS = {
  type: "object",
  properties: {
    tool: { type: "string", description: "Tool to call" },
    args: {
      type: ["object", "string"],
      description: "Arguments for tool (an object; a JSON string is accepted)",
    },
    server: {
      type: "string",
      description: "Limit to this server; list its tools when alone",
    },
    search: {
      type: "string",
      description: "Search tools by name, description and keywords",
    },
    regex: {
      type: "boolean",
      description: "Treat search as a regular expression",
    },
    limit: {
      type: "integer",
      description: "Search results per page (default 12)",
    },
    offset: { type: "integer", description: "Search results to skip" },
    describe: { type: "string", description: "Tool whose schema to show" },
    instructions: {
      type: "string",
      description: "Server whose usage instructions to show",
    },
    connect: { type: "string", description: "Server to connect and refresh" },
  },
} as const;

/** Fixed by the configuration alone, so the prompt prefix a provider caches never changes under it. */
export function proxyDescription(serverNames: readonly string[]): string {
  const servers =
    serverNames.length > 0 ? `\nServers: ${serverNames.join(", ")}` : "";
  return [
    "MCP gateway: use the tools of connected MCP servers without loading them all.",
    servers.trim(),
    "mcp({}) status",
    "mcp({ server }) list a server's tools",
    "mcp({ search, regex?, server?, limit?, offset? }) find tools",
    "mcp({ describe, server? }) a tool's parameters",
    "mcp({ instructions: server }) usage notes",
    "mcp({ tool, args, server? }) call a tool",
    "mcp({ connect: server }) connect and refresh",
  ]
    .filter(Boolean)
    .join("\n");
}

function text(
  value: string,
  details: Record<string, unknown>,
  isError = false,
): McpToolResult {
  return {
    content: [{ type: "text", text: value }],
    ...(isError ? { isError: true } : {}),
    details,
  };
}

function truncateAtWord(value: string, length: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= length) return flat;
  const cut = flat.slice(0, length);
  const space = cut.lastIndexOf(" ");
  return `${(space > length / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Top-level parameter names, required first: `(query, limit?)`. Empty when the schema can't be read. */
function parameterNames(schema: unknown): string {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "";
  const unreadable = [
    "$ref",
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "if",
    "then",
    "else",
    "dependentRequired",
    "dependentSchemas",
    "dependencies",
  ];
  // Composed or conditional schemas can add properties a top-level read would miss.
  if (unreadable.some((keyword) => Object.hasOwn(schema, keyword))) return "";
  const { properties, required } = schema as {
    properties?: unknown;
    required?: unknown;
  };
  if (required !== undefined && !Array.isArray(required)) return "";
  if (
    properties !== undefined &&
    (!properties || typeof properties !== "object" || Array.isArray(properties))
  ) {
    return "";
  }
  const requiredSet = new Set(
    (required ?? []).filter((name): name is string => typeof name === "string"),
  );
  if (
    properties === undefined &&
    requiredSet.size === 0 &&
    (schema as { type?: unknown }).type !== "object"
  ) {
    return "";
  }
  const names = properties ? Object.keys(properties) : [];
  const ordered = [
    ...names.filter((name) => requiredSet.has(name)),
    ...[...requiredSet].filter((name) => !names.includes(name)),
    ...names.filter((name) => !requiredSet.has(name)).map((name) => `${name}?`),
  ];
  return `(${ordered.join(", ")})`;
}

function toolHints(tool: ToolMeta): string {
  const annotations = tool.annotations;
  if (!annotations) return "";
  const hints: string[] = [];
  const flag = (value: boolean | undefined, yes: string, no: string): void => {
    if (value !== undefined) hints.push(value ? yes : no);
  };
  flag(annotations.readOnlyHint, "read-only", "not read-only");
  flag(annotations.destructiveHint, "destructive", "non-destructive");
  flag(annotations.idempotentHint, "idempotent", "not idempotent");
  flag(annotations.openWorldHint, "open-world", "closed-world");
  const title = annotations.title?.trim();
  if (title && title !== tool.name)
    hints.push(`title ${JSON.stringify(title)}`);
  return hints.join(", ");
}

/** Nested quantifiers and backreferences are how a regex goes exponential; none are accepted. */
function unsafeRegexReason(source: string): string | undefined {
  if (source.length > MAX_REGEX_SEARCH_QUERY_LENGTH) {
    return `Regex query is too long; maximum length is ${MAX_REGEX_SEARCH_QUERY_LENGTH} characters.`;
  }
  if (/\\[1-9]|\\k</.test(source))
    return "Regex query rejected as unsafe (backreference).";
  // A group that repeats and itself contains a repeat: scan once, tracking whether each open group
  // has seen an unbounded quantifier.
  const open: boolean[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") {
      i++;
    } else if (inClass) {
      if (char === "]") inClass = false;
    } else if (char === "[") {
      inClass = true;
    } else if (char === "(") {
      open.push(false);
    } else if (char === ")") {
      const repeated = open.pop() ?? false;
      const next = source[i + 1];
      const quantified = next === "+" || next === "*" || next === "{";
      if (repeated && quantified) {
        return "Regex query rejected as unsafe (nested quantifier).";
      }
      // A group's repeat counts for the group around it.
      if (repeated || quantified) {
        if (open.length > 0) open[open.length - 1] = true;
      }
    } else if (char === "+" || char === "*" || char === "{") {
      if (open.length > 0) open[open.length - 1] = true;
    }
  }
  return undefined;
}

export class McpProxy {
  private readonly scope: McpScope;

  constructor(scope: McpScope) {
    this.scope = scope;
  }

  definition(): McpToolDefinition {
    const names = this.scope
      .servers()
      .filter((server) => server.disabled !== true)
      .map((server) => server.name);
    return {
      name: PROXY_TOOL_NAME,
      description: proxyDescription(names),
      parameters: PARAMETERS as unknown as Record<string, unknown>,
      execute: (args, context) => this.execute(args, context),
    };
  }

  async execute(
    rawArgs: unknown,
    context: McpExecuteContext = {},
  ): Promise<McpToolResult> {
    const input = (
      typeof rawArgs === "object" && rawArgs !== null ? rawArgs : {}
    ) as Record<string, unknown>;
    const string = (key: string): string | undefined =>
      typeof input[key] === "string" && input[key] !== ""
        ? input[key]
        : undefined;
    const number = (key: string, fallback: number): number =>
      typeof input[key] === "number" ? input[key] : fallback;

    const tool = string("tool");
    if (tool !== undefined)
      return await this.call(tool, input.args, string("server"), context);
    const connect = string("connect");
    if (connect !== undefined)
      return await this.connect(connect, context.signal);
    const describe = string("describe");
    if (describe !== undefined)
      return await this.describe(describe, string("server"), context.signal);
    const instructions = string("instructions");
    if (instructions !== undefined) return this.instructions(instructions);
    const search = typeof input.search === "string" ? input.search : undefined;
    if (search !== undefined) {
      return this.search(
        search,
        input.regex === true,
        string("server"),
        number("limit", DEFAULT_SEARCH_LIMIT),
        number("offset", 0),
      );
    }
    const server = string("server");
    if (server !== undefined) return this.list(server);
    return this.status();
  }

  // ---- status -------------------------------------------------------------------------------

  status(): McpToolResult {
    const servers = this.scope.status();
    const enabled = servers.filter((server) => server.state !== "disabled");
    const connected = enabled.filter(
      (server) => server.state === "connected",
    ).length;
    const total = enabled.reduce((sum, server) => sum + server.toolCount, 0);
    const disabled = servers.length - enabled.length;

    let out = `MCP: ${connected}/${enabled.length} servers, ${total} tools`;
    if (disabled > 0) out += ` (${disabled} disabled)`;
    out += "\n\n";
    for (const server of servers) out += `${statusLine(server)}\n`;
    if (servers.length > 0) {
      out += `\nmcp({ server: "name" }) to list tools, mcp({ search: "..." }) to search`;
    }
    return text(out.trim(), {
      mode: "status",
      servers,
      totalTools: total,
      connectedCount: connected,
      disabledCount: disabled,
    });
  }

  // ---- list ---------------------------------------------------------------------------------

  list(server: string): McpToolResult {
    const definition = this.scope.definition(server);
    if (!definition) return this.notFound("list", server);
    if (definition.disabled === true) {
      return text(
        `Server "${server}" is disabled.`,
        { mode: "list", error: "server_disabled", server },
        true,
      );
    }
    const failure = this.scope.failure(server);
    if (failure !== undefined) {
      return text(
        `Server "${server}" not available (last ${failure})`,
        { mode: "list", error: "server_backoff", server, tools: [], count: 0 },
        true,
      );
    }

    const tools = this.scope.tools(server);
    const instructions = this.scope.instructions(server);
    let instructionsText = "";
    if (instructions) {
      const preview = truncateAtWord(instructions, INSTRUCTIONS_PREVIEW_LENGTH);
      instructionsText = `\n\nServer instructions:\n${preview}`;
      if (preview !== instructions.replace(/\s+/g, " ").trim()) {
        instructionsText += `\nUse mcp({ instructions: "${server}" }) for the full text.`;
      }
    }
    const description = definition.description?.replace(/\s+/g, " ").trim();
    const descriptionText = description ? `\nDescription: ${description}` : "";
    const hasInstructions = Boolean(instructions);

    if (tools === undefined) {
      return text(
        `Server "${server}" is configured but its tools are not known yet. Use mcp({ connect: "${server}" }) to connect.${descriptionText}`,
        {
          mode: "list",
          server,
          tools: [],
          count: 0,
          error: "not_connected",
          hasInstructions,
        },
        true,
      );
    }
    const state = this.scope
      .status()
      .find((status) => status.name === server)?.state;
    if (tools.length === 0) {
      return text(
        `Server "${server}" has no tools.${descriptionText}${instructionsText}`,
        { mode: "list", server, tools: [], count: 0, hasInstructions },
      );
    }

    let note = "";
    if (state === "needs-auth") note = " (needs sign-in)";
    else if (state !== "connected")
      note = ` (lazy: tools from cache, not connected yet; mcp({ connect: "${server}" }) to connect)`;
    let out = `${server} (${tools.length} tools${note}):${descriptionText}\n\n`;
    for (const tool of tools) {
      const summary = truncateAtWord(tool.description, 50);
      out += `- ${tool.name}${parameterNames(tool.inputSchema)}${requiresApproval(definition.approveTools, server, tool) ? " (requires approval)" : ""}`;
      if (summary) out += ` - ${summary}`;
      out += "\n";
    }
    out += instructionsText;
    return text(out.trim(), {
      mode: "list",
      server,
      tools: tools.map((tool) => tool.name),
      count: tools.length,
      hasInstructions,
    });
  }

  // ---- search -------------------------------------------------------------------------------

  search(
    query: string,
    regex: boolean,
    server: string | undefined,
    limit: number,
    offset: number,
  ): McpToolResult {
    const failure = (
      message: string,
      details: Record<string, unknown>,
    ): McpToolResult =>
      text(message, { mode: "search", query, ...details }, true);
    if (server !== undefined) {
      const definition = this.scope.definition(server);
      if (!definition) return this.notFound("search", server);
      if (definition.disabled === true) {
        return failure(`Server "${server}" is disabled.`, {
          error: "server_disabled",
          server,
        });
      }
      const backoff = this.scope.failure(server);
      if (backoff !== undefined) {
        return failure(`Server "${server}" not available (last ${backoff})`, {
          error: "server_backoff",
          server,
        });
      }
    }
    const entries = this.scope.entries(server);

    let matches: Array<{ server: string; tool: ToolMeta; score: number }>;
    if (regex) {
      const unsafe = unsafeRegexReason(query);
      if (unsafe !== undefined)
        return failure(unsafe, { error: "unsafe_pattern" });
      let pattern: RegExp;
      try {
        pattern = new RegExp(query, "i");
      } catch {
        return failure(`Invalid regex: ${query}`, { error: "invalid_pattern" });
      }
      matches = entries
        .filter(
          (entry) =>
            pattern.test(entry.tool.name) ||
            pattern.test(entry.tool.description) ||
            (entry.keywords ?? []).some((keyword) => pattern.test(keyword)),
        )
        .map((entry) => ({ server: entry.server, tool: entry.tool, score: 0 }));
    } else if (query.trim().length === 0) {
      if (server === undefined)
        return failure("Search query cannot be empty", {
          error: "empty_query",
        });
      matches = entries
        .map((entry) => ({ server: entry.server, tool: entry.tool, score: 0 }))
        .sort((a, b) => a.tool.name.localeCompare(b.tool.name));
    } else {
      matches = rankTools(entries, query);
    }

    const page = paginate(matches, offset, limit);
    if (page.total === 0) {
      const connecting = this.scope
        .servers()
        .filter(
          (definition) =>
            definition.disabled !== true &&
            (server === undefined || definition.name === server),
        )
        .filter(
          (definition) => this.scope.tools(definition.name) === undefined,
        );
      const hint =
        connecting.length > 0
          ? ` Tools of ${connecting.map((definition) => `"${definition.name}"`).join(", ")} are not known yet; mcp({ connect: "..." }) loads them.`
          : "";
      return text(
        `No tools matching "${query}"${server ? ` in "${server}"` : ""}.${hint}`,
        {
          mode: "search",
          matches: [],
          count: 0,
          hasMore: false,
          nextOffset: null,
          query,
        },
      );
    }

    let out = `Found ${page.total} tool${page.total === 1 ? "" : "s"} matching "${query}":\n\n`;
    for (const match of page.items) {
      const definition = this.scope.definition(match.server);
      const marker = requiresApproval(
        definition?.approveTools,
        match.server,
        match.tool,
      )
        ? " (requires approval)"
        : "";
      out += `- ${match.tool.name} [${match.server}]${marker}`;
      const summary = truncateAtWord(match.tool.description, 50);
      if (summary) out += ` - ${summary}`;
      out += "\n";
      const shape =
        match.tool.inputSchema === undefined
          ? null
          : renderTsShape(match.tool.inputSchema);
      if (shape !== null) out += `    ${shape.split("\n").join("\n    ")}\n`;
      else {
        const names = parameterNames(match.tool.inputSchema);
        if (names) out += `    ${names}\n`;
      }
    }
    if (page.hasMore)
      out += `\n${page.items.length} of ${page.total}, offset: ${page.nextOffset} for more\n`;
    return text(out.trim(), {
      mode: "search",
      matches: page.items.map((match) => ({
        server: match.server,
        tool: match.tool.name,
        score: match.score,
      })),
      count: page.total,
      hasMore: page.hasMore,
      nextOffset: page.nextOffset,
      query,
    });
  }

  // ---- describe -----------------------------------------------------------------------------

  async describe(
    requested: string,
    server: string | undefined,
    signal?: AbortSignal,
  ): Promise<McpToolResult> {
    const resolved = await this.resolve("describe", requested, server, signal);
    if ("error" in resolved) return resolved.error;
    const { tool } = resolved;
    const definition = this.scope.definition(resolved.server);
    const gated = requiresApproval(
      definition?.approveTools,
      resolved.server,
      tool,
    )
      ? " (requires approval)"
      : "";

    // Each long part is bounded on its own, so one cannot push another's notice out of the result:
    // the description gets half of the budget, each schema and shape the whole of it.
    const guard = this.guard();
    const half: OutputGuardOptions = {
      ...guard,
      maxBytes: Math.floor((guard.maxBytes ?? DEFAULT_MAX_BYTES) / 2),
      maxLines: Math.floor((guard.maxLines ?? DEFAULT_MAX_LINES) / 2),
    };
    const guards: OutputGuardDetails[] = [];
    const bounded = (
      value: string,
      kind: string,
      options: OutputGuardOptions,
    ): string => {
      const guarded = guardText(value, kind, options);
      if (guarded.guard) guards.push(guarded.guard);
      return guarded.text;
    };
    const json = (value: unknown): string =>
      `\`\`\`json\n${bounded(JSON.stringify(value, null, 2), "schema", guard)}\n\`\`\``;

    let out = `${tool.name}${gated}\nServer: ${resolved.server}\n`;
    const hints = toolHints(tool);
    if (hints) out += `Hints: ${hints}\n`;
    out += `\n${bounded(tool.description || "(no description)", "description", half)}\n`;
    out += tool.inputSchema
      ? `\nInput schema (JSON Schema):\n${json(tool.inputSchema)}`
      : "\nNo parameters defined.";
    if (tool.outputSchema !== undefined) {
      out += `\n\nOutput schema (JSON Schema):\n${json(tool.outputSchema)}`;
    } else {
      const observed = this.scope.observedFor(resolved.server, tool);
      if (observed) {
        const source =
          observed.source === "structuredContent"
            ? "structuredContent"
            : "JSON text result";
        out += `\n\nObserved output (${source}, from earlier calls, not a contract):\n${renderOutputShape(observed.shape)}`;
      }
    }
    return text(out.trim(), {
      mode: "describe",
      server: resolved.server,
      tool,
      name: qualifiedToolName(resolved.server, tool.name),
      ...(guards.length > 0 ? { outputGuard: guards } : {}),
    });
  }

  private guard(): OutputGuardOptions {
    return this.scope.guardOptions();
  }

  // ---- instructions & connect ---------------------------------------------------------------

  instructions(server: string): McpToolResult {
    const definition = this.scope.definition(server);
    if (!definition) return this.notFound("instructions", server);
    if (definition.disabled === true) {
      return text(
        `Server "${server}" is disabled.`,
        { mode: "instructions", error: "server_disabled", server },
        true,
      );
    }
    const backoff = this.scope.failure(server);
    if (backoff !== undefined) {
      return text(
        `Server "${server}" not available (last ${backoff})`,
        { mode: "instructions", error: "server_backoff", server },
        true,
      );
    }
    const instructions = this.scope.instructions(server);
    if (instructions) {
      return text(`${server} instructions:\n\n${instructions}`, {
        mode: "instructions",
        server,
        length: instructions.length,
      });
    }
    if (this.scope.tools(server) !== undefined) {
      return text(`Server "${server}" does not provide instructions.`, {
        mode: "instructions",
        server,
        error: "no_instructions",
      });
    }
    return text(
      `No instructions cached for "${server}". Use mcp({ connect: "${server}" }) to connect and refresh.`,
      { mode: "instructions", server, error: "not_connected" },
      true,
    );
  }

  async connect(server: string, signal?: AbortSignal): Promise<McpToolResult> {
    if (!this.scope.definition(server)) return this.notFound("connect", server);
    // An explicit connect ignores a recent failure: the model is asking to try again.
    const outcome = await this.scope.connect(server, { signal, force: true });
    if (!outcome.ok) {
      const error =
        outcome.error === "needs_auth" ? "auth_required" : outcome.error;
      const message =
        outcome.error === "needs_auth"
          ? `Server "${server}" requires authentication: ${outcome.message}.`
          : outcome.error === "connect_failed"
            ? `Failed to connect to "${server}": ${outcome.message}`
            : outcome.message;
      return text(
        message,
        { mode: "connect", error, server, message: outcome.message },
        true,
      );
    }
    return this.list(server);
  }

  // ---- call ---------------------------------------------------------------------------------

  async call(
    requested: string,
    rawArgs: unknown,
    server: string | undefined,
    context: McpExecuteContext,
  ): Promise<McpToolResult> {
    let args: Record<string, unknown>;
    try {
      args = normalizeToolArguments(rawArgs);
    } catch (error) {
      return text(
        `Failed to call tool: ${error instanceof Error ? error.message : String(error)}`,
        {
          mode: "call",
          error: "call_failed",
          delivery: "not_sent",
          requestedTool: requested,
        },
        true,
      );
    }
    const resolved = await this.resolve(
      "call",
      requested,
      server,
      context.signal,
    );
    if ("error" in resolved) return resolved.error;
    return await this.scope.callTool(
      resolved.server,
      resolved.tool,
      args,
      context,
    );
  }

  // ---- name resolution ----------------------------------------------------------------------

  private notFound(mode: string, server: string): McpToolResult {
    return text(
      `Server "${server}" not found. Use mcp({}) to see available servers.`,
      { mode, error: "server_not_found", server },
      true,
    );
  }

  /**
   * Finds the tool a model means: on the named server or across all of them; exact names first,
   * then qualified names, then hyphen/underscore-folded ones. A server whose tools were never read
   * is connected when the request points at it. Misses come back with suggestions.
   */
  private async resolve(
    mode: "call" | "describe",
    requested: string,
    server: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ server: string; tool: ToolMeta } | { error: McpToolResult }> {
    if (server !== undefined) {
      const definition = this.scope.definition(server);
      if (!definition) return { error: this.notFound(mode, server) };
      if (definition.disabled === true) {
        return {
          error: text(
            `Server "${server}" is disabled.`,
            { mode, error: "server_disabled", server },
            true,
          ),
        };
      }
      const backoff = this.scope.failure(server);
      if (backoff !== undefined && this.scope.tools(server) === undefined) {
        return {
          error: text(
            `Server "${server}" not available (last ${backoff})`,
            { mode, error: "server_backoff", server, requestedTool: requested },
            true,
          ),
        };
      }
      const loaded = await this.scope.toolsOrConnect(server, signal);
      if (!loaded.ok)
        return { error: this.connectFailure(mode, server, requested, loaded) };
    }

    let entries = this.scope.entries(server);
    let hits = findTools(
      requested,
      entries.map((entry) => ({ server: entry.server, name: entry.tool.name })),
    );

    if (hits.length === 0 && server === undefined) {
      // Not found among what is known: a server named in the request may just never have been read.
      const unknown = this.scope
        .servers()
        .filter(
          (definition) =>
            definition.disabled !== true &&
            this.scope.tools(definition.name) === undefined &&
            [
              `mcp__${definition.name}__`,
              `${definition.name}__`,
              `${definition.name}_`,
            ].some((prefix) => requested.startsWith(prefix)),
        );
      for (const definition of unknown) {
        await this.scope.toolsOrConnect(definition.name, signal);
      }
      if (unknown.length > 0) {
        entries = this.scope.entries();
        hits = findTools(
          requested,
          entries.map((entry) => ({
            server: entry.server,
            name: entry.tool.name,
          })),
        );
      }
    }

    if (hits.length > 1) {
      const names = hits.map((hit) => hit.server).join(", ");
      const message = `Tool "${requested}" matches multiple servers (${names}). Specify a server.`;
      return {
        error: text(
          message,
          {
            mode,
            error: "ambiguous_tool",
            requestedTool: requested,
            servers: hits.map((hit) => hit.server),
            message,
          },
          true,
        ),
      };
    }
    const hit = hits[0];
    if (hit) {
      const tool = entries.find(
        (entry) => entry.server === hit.server && entry.tool.name === hit.name,
      )?.tool;
      if (tool) return { server: hit.server, tool };
    }
    return { error: this.toolNotFound(mode, requested, server, entries) };
  }

  private connectFailure(
    mode: string,
    server: string,
    requested: string,
    outcome: Extract<Awaited<ReturnType<McpScope["connect"]>>, { ok: false }>,
  ): McpToolResult {
    const error =
      outcome.error === "needs_auth" ? "auth_required" : outcome.error;
    const message =
      outcome.error === "needs_auth"
        ? `Server "${server}" requires authentication: ${outcome.message}.`
        : outcome.error === "connect_failed"
          ? `Failed to connect to "${server}": ${outcome.message}`
          : outcome.message;
    return text(
      message,
      {
        mode,
        error,
        server,
        requestedTool: requested,
        delivery: "not_sent",
        message: outcome.message,
      },
      true,
    );
  }

  private toolNotFound(
    mode: string,
    requested: string,
    server: string | undefined,
    entries: readonly SearchEntry[],
  ): McpToolResult {
    const suggestions = suggest(entries, requested, SUGGESTIONS);
    const scope = server ? ` on server "${server}"` : "";
    const search = server
      ? `mcp({ search: "...", server: "${server}" })`
      : `mcp({ search: "..." })`;
    let message = `Tool "${requested}" not found${scope}. Use ${search} to search.`;
    if (suggestions.length > 0)
      message += ` Did you mean: ${suggestions.join(", ")}`;
    const unknown = this.scope
      .servers()
      .filter(
        (definition) =>
          definition.disabled !== true &&
          this.scope.tools(definition.name) === undefined,
      )
      .map((definition) => definition.name);
    if (unknown.length > 0 && server === undefined) {
      message += `\nTools of ${unknown.join(", ")} are not known yet; mcp({ connect: "..." }) loads them.`;
    }
    return text(
      message,
      {
        mode,
        error: "tool_not_found",
        server,
        requestedTool: requested,
        suggestions,
      },
      true,
    );
  }
}

function statusLine(server: ServerStatus): string {
  switch (server.state) {
    case "connected":
      return `✓ ${server.name} (${server.toolCount} tools)`;
    case "cached":
      return `○ ${server.name} (${server.toolCount} tools, cached; not connected)`;
    case "needs-auth":
      return `⚠ ${server.name} (needs auth${server.error ? `: ${server.error}` : ""})`;
    case "failed":
      return `✗ ${server.name} (failed ${server.failedAgoSeconds ?? 0}s ago${server.error ? `: ${server.error}` : ""})`;
    case "disabled":
      return `⊘ ${server.name} (disabled)`;
    case "not-connected":
      return `○ ${server.name} (not connected; tools unknown)`;
  }
}
