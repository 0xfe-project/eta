/**
 * MCP realm adapter: wraps {@link McpScope} as the harness {@link McpSink}.
 *
 * The harness has no dependency on @eta/mcp; this adapter lets a host wire the two.
 * The sink gives the realm linker enough to build `mcp:<server>` imports and `eta.mcp` exports.
 */
import type { McpScope } from "./scope";
import type { ToolMeta } from "./types";
import { describeServerTools } from "./describe";
import { rankTools } from "./search-ranking";

/** The structural McpSink the harness knows about; matches realm/hooks.ts. */
export interface McpSink {
  servers: () => {
    name: string;
    toolCount: number;
    status: string;
    error?: string;
  }[];
  load: (server: string) => Promise<ToolMeta[]>;
  search: (
    query: string,
  ) => { server: string; tool: ToolMeta; score: number }[];
  describe: (server: string) => string;
  callTool: (
    server: string,
    tool: ToolMeta,
    args: Record<string, unknown>,
    context?: { signal?: AbortSignal; toolCallId?: string },
  ) => Promise<unknown>;
}

/**
 * Wraps a scope as the sink the harness needs.
 * The scope owns the connections and the cache; the sink only reads and calls.
 */
export function createMcpRealmAdapter(scope: McpScope): McpSink {
  return {
    servers: () =>
      scope.status().map(({ name, state, toolCount, error }) => ({
        name,
        status: state,
        toolCount,
        ...(error === undefined ? {} : { error }),
      })),
    load: async (server: string) => {
      const outcome = await scope.toolsOrConnect(server);
      if (!outcome.ok)
        throw new Error(`MCP server "${server}": ${outcome.message}`);
      return outcome.tools;
    },
    search: (query: string) => {
      const matches = rankTools(scope.entries(), query);
      return matches
        .slice(0, 50)
        .map(({ server, tool, score }) => ({ server, tool, score }));
    },
    describe: (server: string) => describeServerTools(scope, server),
    callTool: async (server, tool, args, context) => {
      const result = await scope.callTool(server, tool, args, context ?? {});
      if (result.isError === true) {
        const text = result.content
          .flatMap((b) => (b.type === "text" ? [b.text] : []))
          .join("\n");
        throw new Error(text || "tool call failed");
      }
      // Prefer structuredContent, else text content blocks.
      const structured = (result.details as { structuredContent?: unknown })
        .structuredContent;
      if (structured !== undefined && structured !== null) return structured;
      return result.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("\n");
    },
  };
}
