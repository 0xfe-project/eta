/**
 * The host's tools, told back as the host's.
 *
 * A host tool reaches a runtime over MCP (`serveMcpTools`), and two things do not survive the trip:
 *
 * - **The name.** Each runtime reports a call in its own spelling: Claude Code and Pi say
 *   `mcp__eta__x`, OpenCode says `eta_x`, Antigravity says `mcp_eta_x` (and adds `toolSummary` to
 *   arguments), and Codex says `mcpToolCall` for every MCP tool and names
 *   the server and the tool only in its native frame. Grok Build calls every MCP tool through its
 *   own `use_tool`, naming it `eta__x` beside the tool's own arguments (`tool_input`), and wraps
 *   the answer (`gateway`). The transcript holds the name the host gave the tool, whoever called
 *   it, so what reads a tool by name reads it the same on every run. Only tools this server serves
 *   are restored: a user's own MCP tools keep the runtime's name (through Grok's gateway, the
 *   `<server>__x` it calls them by, its answer unwrapped).
 * - **The details.** An MCP answer is its content and `isError`, so what a tool left for the page
 *   stays on this side, with the handler. The handler is not told the runtime's call id and the
 *   runtime is not told the handler's, so the end of a call finds its answer by what both sides
 *   saw: the tool, the arguments and the answer's text, which is what tells two calls of one tool
 *   apart however they overlap. Calls that agree on all three read the same whichever details
 *   each gets. The text is compared, never parsed; a runtime that rewrites it or the arguments
 *   still finds the answer by the other.
 *
 * One of these lives for one run, so an answer nobody took (a call the run was aborted under) is
 * not there for the next run's calls to find.
 */
import type { RawEvent, ToolOutputPart } from "@botiverse/oar";
import type { RuntimeId } from "./catalog";
import { HOST_SERVER } from "@eta/runtime-kit";

/** How a runtime spells a host tool in its events. Codex's events do not: see `see`. */
const PREFIXES: Partial<Record<RuntimeId, string>> = {
  claude: `mcp__${HOST_SERVER}__`,
  pi: `mcp__${HOST_SERVER}__`,
  opencode: `${HOST_SERVER}_`,
  antigravity: `mcp_${HOST_SERVER}_`,
};

/** Runtime-injected extra parameter keys on host tool calls that the host tool did not declare. */
const EXTRA_ARG_KEYS: Partial<Record<RuntimeId, readonly string[]>> = {
  antigravity: ["toolSummary"],
};

/** A runtime's one tool that calls any MCP tool, by the name it is called under. */
const GATEWAYS: Partial<Record<RuntimeId, string>> = {
  // Grok Build 1.0.89: `use_tool { tool_name: "eta__x", tool_input }`; `search_tool` lists them.
  grok: "use_tool",
};

/** How a gateway call names an MCP tool: Grok's `search_tool` answers `<server>__x`. */
const GATEWAY_PREFIX = `${HOST_SERVER}__`;

interface Answer {
  name: string;
  input: string;
  text: string;
  details: Record<string, unknown> | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function withoutExtras(runtime: RuntimeId, value: unknown): unknown {
  const extras = EXTRA_ARG_KEYS[runtime];
  if (extras === undefined || !isRecord(value)) return value;
  if (!extras.some((key) => key in value)) return value;
  const copy = { ...value };
  for (const key of extras) delete copy[key];
  return copy;
}

/** A value as text that does not depend on the order of its keys. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    isRecord(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : inner,
  );

/** A result's words, without the spacing a runtime may join its blocks with. */
const wordsOf = (parts: readonly { type: string; text?: string }[]): string =>
  parts
    .flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
    .join("")
    .replaceAll(/\s+/gu, "");

export class HostCalls {
  readonly #runtime: RuntimeId;
  readonly #tools: ReadonlySet<string>;
  /** The calls a native frame named, by the runtime's call id. */
  readonly #named = new Map<string, string>();
  /** What the tools answered, oldest first, until the end of a call takes it. */
  readonly #answers: Answer[] = [];

  constructor(runtime: RuntimeId, tools: ReadonlySet<string>) {
    this.#runtime = runtime;
    this.#tools = tools;
  }

  /** A record of the runtime's stream, seen before the events read out of it. */
  see(record: RawEvent): void {
    if (
      this.#runtime !== "codex" ||
      record.kind !== "frame" ||
      record.body.type !== "item/started"
    )
      return;
    const { item } = record.body.native as {
      item?: { type?: unknown; id?: unknown; server?: unknown; tool?: unknown };
    };
    if (
      item?.type === "mcpToolCall" &&
      item.server === HOST_SERVER &&
      typeof item.id === "string" &&
      typeof item.tool === "string" &&
      this.#tools.has(item.tool)
    )
      this.#named.set(item.id, item.tool);
  }

  /** The host tool a runtime's call is; undefined when it is anything else. */
  hostTool(callId: string, tool: string): string | undefined {
    const named = this.#named.get(callId);
    if (named !== undefined) return named;
    const prefix = PREFIXES[this.#runtime];
    if (prefix === undefined || !tool.startsWith(prefix)) return undefined;
    const name = tool.slice(prefix.length);
    return this.#tools.has(name) ? name : undefined;
  }

  /**
   * A call to the runtime's MCP gateway tool (Grok's `use_tool`) as the MCP tool it calls, with
   * that tool's own arguments: a host tool under the host's name, any other (a plugin's) under the
   * name the runtime gave it (`probe__echo`). Undefined for any other call.
   */
  gateway(
    tool: string,
    args: Record<string, unknown>,
  ): { name: string; args: Record<string, unknown> } | undefined {
    if (tool !== GATEWAYS[this.#runtime]) return undefined;
    const named = args.tool_name;
    if (typeof named !== "string" || named === "") return undefined;
    const bare = named.startsWith(GATEWAY_PREFIX)
      ? named.slice(GATEWAY_PREFIX.length)
      : undefined;
    // Arguments handed over in a file (`tool_input_file`, `file`) are not seen here.
    return {
      name: bare !== undefined && this.#tools.has(bare) ? bare : named,
      args: isRecord(args.tool_input) ? args.tool_input : {},
    };
  }

  /**
   * A gateway call's answer as the MCP tool's: the output the runtime wrapped
   * (`{ type: "MCP", server_name, output: { OkayOutput } }`) as its text, anything else as it is.
   */
  gatewayResult(parts: readonly ToolOutputPart[]): ToolOutputPart[] {
    return parts.map((part) => {
      if (part.type !== "other" || !isRecord(part.value)) return part;
      const { type, output } = part.value;
      if (type !== "MCP" || !isRecord(output)) return part;
      const [said] = Object.values(output);
      return {
        type: "text",
        text: typeof said === "string" ? said : JSON.stringify(output),
      };
    });
  }

  /** Strip runtime-injected extra parameters from a host tool call's arguments object. */
  normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    return withoutExtras(this.#runtime, args) as Record<string, unknown>;
  }

  /** A tool answered: what it said, and what it left beside that. */
  answered(
    name: string,
    input: unknown,
    content: readonly { type: string; text?: string }[],
    details: unknown,
  ): void {
    this.#answers.push({
      name,
      input: canonical(withoutExtras(this.#runtime, input)),
      text: wordsOf(content),
      details: isRecord(details) ? details : undefined,
    });
  }

  /** The details a finished call's answer left, once: that answer is spent. */
  take(
    name: string,
    args: unknown,
    parts: readonly ToolOutputPart[],
  ): Record<string, unknown> | undefined {
    const same = this.#answers.filter((answer) => answer.name === name);
    const input = canonical(withoutExtras(this.#runtime, args));
    const text = wordsOf(parts);
    const found =
      same.find((answer) => answer.text === text && answer.input === input) ??
      same.find((answer) => answer.text === text) ??
      same.find((answer) => answer.input === input);
    if (found === undefined) return undefined;
    this.#answers.splice(this.#answers.indexOf(found), 1);
    return found.details;
  }
}
