/**
 * The host's tools (a task board, a way to reach other agents), served to an external runtime
 * over MCP: the part of that both sides of the runtime seam share, whatever protocol the runtime
 * speaks.
 *
 * - **The definition** of a tool exists once, on the host: its name, description and parameters
 *   go to the runtime unchanged (`hostToolDefinition`).
 * - **A call** runs through the session's own middleware chain, under the run in flight, so a
 *   tool's policy is the same whoever calls it. The adapter says how (`call`): it owns the run.
 * - **The set** is read from the session again at every run. One that differs from what is
 *   served (a tool came or went, a description or a schema changed) is served anew on the same
 *   server, which sends `notifications/tools/list_changed`, so the runtime lists again without
 *   being restarted. What it does with that is its own business. Claude Code (2.1.325, measured
 *   in #177) lists again at once, so a tool it has not loaded yet, or a tool that is new, comes in
 *   the new version; a tool it already loaded with ToolSearch keeps the definition of that first
 *   load for the rest of the conversation, resumes included, because it is in its transcript.
 *
 * One server for the life of a delegate. A runtime opened when the session had no host tools was
 * given no server, so it hears of tools that come later only when it is opened again.
 */
import type {
  HostTool,
  HostToolContent,
  HostToolResult,
  ServedMcpTools,
} from "@botiverse/oar";
import type { KernelTool, RunDelegateContext } from "@eta/core";
import { serveMcpTools } from "@botiverse/oar";
import { toToolResultMessage } from "@eta/core";

export type { HostToolResult };

/** The MCP server the host's tools are served under: what runtimes build their spellings from. */
export const HOST_SERVER = "eta";

/** The served server, as a runtime is told of it: http on 127.0.0.1, its bearer token in `headers`. */
export type HostToolServer = ServedMcpTools["server"];

/** What a call gets when no run is in flight to take it. */
export const NO_RUN: Exclude<HostToolResult, string> = {
  content: [{ type: "text", text: "No run is in flight." }],
  isError: true,
};

/**
 * A session tool as an MCP tool definition: the name, description and parameters the eta runtime
 * gives its model, unchanged. The definition exists once, on the host; this only carries it.
 */
function hostToolDefinition(tool: KernelTool): Omit<HostTool, "handler"> {
  return {
    name: tool.name,
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    inputSchema: ((tool as { parameters?: Record<string, unknown> })
      .parameters ?? {
      type: "object",
      properties: {},
    }) as Record<string, unknown>,
  };
}

/** What tells one served tool set from another: everything the runtime is shown of it. */
function signatureOf(tools: readonly HostTool[]): string {
  return JSON.stringify(
    tools.map(({ name, description, inputSchema }) => [
      name,
      description,
      inputSchema,
    ]),
  );
}

/** A session tool's result as an MCP tool answer, and the details that answer cannot carry. */
export function hostResultOf(
  name: string,
  raw: unknown,
): {
  result: Exclude<HostToolResult, string>;
  details: unknown;
} {
  const message = toToolResultMessage({ id: name, name }, raw);
  if (message.role !== "toolResult")
    return {
      result: { content: [{ type: "text", text: String(raw) }] },
      details: undefined,
    };
  const content: HostToolContent[] = message.content.map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : { type: "image", data: block.data, mimeType: block.mimeType },
  );
  return {
    result: { content, isError: message.isError },
    details: message.details,
  };
}

export interface HostToolsOptions {
  /** The host's tools this session is offered, by name; read at every listing. */
  offered: () => readonly string[];
  /** Run one call of a host tool; the adapter knows the run in flight. */
  call: (
    name: string,
    input: Readonly<Record<string, unknown>>,
  ) => Promise<HostToolResult>;
}

/** The host's tools of one session, served to its runtime and kept current. */
export class HostTools {
  readonly #options: HostToolsOptions;
  #served: ServedMcpTools | undefined;
  /** What `#served` lists, to tell a changed tool set from the same one. */
  #signature: string | undefined;
  #names: ReadonlySet<string> = new Set();

  constructor(options: HostToolsOptions) {
    this.#options = options;
  }

  /** The names of the tools served now. */
  get names(): ReadonlySet<string> {
    return this.#names;
  }

  /**
   * The server, with the tools as they are now: started on the first call that has any to
   * serve, and given the new list (with `list_changed`) whenever it differs. `undefined` while
   * there is nothing to serve and no server yet.
   */
  async serve(
    context: RunDelegateContext,
  ): Promise<HostToolServer | undefined> {
    const tools = this.#listed(context);
    const signature = signatureOf(tools);
    if (this.#served !== undefined) {
      if (signature !== this.#signature) {
        this.#served.setTools(tools);
        this.#signature = signature;
        this.#names = new Set(tools.map((tool) => tool.name));
      }
      return this.#served.server;
    }
    if (tools.length === 0) return undefined;
    this.#served = await serveMcpTools({ name: HOST_SERVER, tools });
    this.#signature = signature;
    this.#names = new Set(tools.map((tool) => tool.name));
    return this.#served.server;
  }

  /**
   * At the start of a run: the server, where there is one, takes the tools as they are now. A
   * runtime given no server is not given one here; it was opened without it.
   */
  async refresh(context: RunDelegateContext): Promise<void> {
    if (this.#served !== undefined) await this.serve(context);
  }

  /** Stop serving; calls still running are aborted. */
  async close(): Promise<void> {
    const served = this.#served;
    this.#served = undefined;
    this.#signature = undefined;
    this.#names = new Set();
    await served?.close().catch(() => undefined);
  }

  /** The host's tools for the runtime, read from the session now. */
  #listed(context: RunDelegateContext): HostTool[] {
    const names = new Set(this.#options.offered());
    return context
      .tools()
      .filter((tool) => names.has(tool.name))
      .map((tool) => ({
        ...hostToolDefinition(tool),
        handler: async (input) => await this.#options.call(tool.name, input),
      }));
  }
}
