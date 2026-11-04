/**
 * The host's tools, told back as the host's.
 *
 * A host tool reaches a runtime over MCP (`serveMcpTools`), and two things do not survive the trip:
 *
 * - **The name.** Each runtime reports a call in its own spelling: Claude Code and Pi say
 *   `mcp__eta__x`, OpenCode says `eta_x`, and Codex says `mcpToolCall` for every MCP tool and names
 *   the server and the tool only in its native frame. The transcript holds the name the host gave
 *   the tool, whoever called it, so what reads a tool by name reads it the same on every run. Only
 *   tools this server serves are restored: a user's own MCP tools keep the runtime's name.
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

/** The name the host's MCP server goes by: what runtimes build their spellings from. */
export const HOST_SERVER = "eta";

/** How a runtime spells a host tool in its events. Codex's events do not: see `see`. */
const PREFIXES: Partial<Record<RuntimeId, string>> = {
  claude: `mcp__${HOST_SERVER}__`,
  pi: `mcp__${HOST_SERVER}__`,
  opencode: `${HOST_SERVER}_`,
};

interface Answer {
  name: string;
  input: string;
  text: string;
  details: Record<string, unknown> | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

  /** A tool answered: what it said, and what it left beside that. */
  answered(
    name: string,
    input: unknown,
    content: readonly { type: string; text?: string }[],
    details: unknown,
  ): void {
    this.#answers.push({
      name,
      input: canonical(input),
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
    const input = canonical(args);
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
