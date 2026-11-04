// Ported from pi-mcp-adapter/direct-tool-surface.ts#resolveDirectTools and direct-tools.ts (MIT, see ../NOTICE); definitions only, the registering is the caller's.
/**
 * Tools a server's config puts straight into the model's tool list (`directTools`), so the model
 * can call them without going through `mcp`.
 *
 * The definitions come from the metadata cache, so they exist before any server starts and a stale
 * server costs nothing; executing one connects lazily like any call. A server with no cache yet
 * contributes nothing until `warmUp` has read it (then `onUpdated` fires and this is asked again).
 */
import type { McpScope } from "./scope";
import type { McpToolDefinition } from "./types";
import { normalizeToolArguments } from "./json-schema";
import { directToolName, foldName } from "./names";
import { guardText } from "./output-guard";

/** A direct tool's description is in the prompt on every turn; past this it is saved to a file. */
const DESCRIPTION_MAX_BYTES = 4 * 1024;
const DESCRIPTION_MAX_LINES = 80;

export interface DirectToolOptions {
  /** Names the caller already has (its own tools); a direct tool with one of them is skipped. */
  reserved?: ReadonlySet<string>;
}

/** The direct tools of the scope's servers, in server then tool order. */
export function directToolDefinitions(
  scope: McpScope,
  options: DirectToolOptions = {},
): McpToolDefinition[] {
  const definitions: McpToolDefinition[] = [];
  const taken = new Set(options.reserved);
  const collisions = new Set<string>();

  for (const server of scope.servers()) {
    const selected = server.directTools;
    if (
      server.disabled === true ||
      selected === undefined ||
      selected === false
    )
      continue;
    const tools = scope.tools(server.name);
    if (!tools) continue;
    const wanted =
      selected === true ? undefined : new Set(selected.map(foldName));
    for (const tool of tools) {
      if (wanted && !wanted.has(foldName(tool.name))) continue;
      const name = directToolName(server.name, tool.name);
      if (taken.has(name)) {
        collisions.add(name);
        continue;
      }
      taken.add(name);
      const description = guardText(
        tool.description || `MCP tool ${tool.name} (${server.name})`,
        "description",
        {
          ...scope.guardOptions(),
          maxBytes: DESCRIPTION_MAX_BYTES,
          maxLines: DESCRIPTION_MAX_LINES,
        },
      ).text;
      const definition: McpToolDefinition = {
        name,
        description,
        parameters: (tool.inputSchema && typeof tool.inputSchema === "object"
          ? tool.inputSchema
          : { type: "object", properties: {} }) as Record<string, unknown>,
        execute: async (args, context) => {
          const current =
            scope
              .tools(server.name)
              ?.find((candidate) => candidate.name === tool.name) ?? tool;
          let parsed: Record<string, unknown>;
          try {
            parsed = normalizeToolArguments(args);
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to call tool: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              isError: true,
              details: {
                mode: "call",
                error: "call_failed",
                delivery: "not_sent",
                server: server.name,
                tool: tool.name,
              },
            };
          }
          return await scope.callTool(server.name, current, parsed, context);
        },
      };
      definitions.push(definition);
    }
  }

  // Two servers (or tools) that sanitise to one name: neither gets the name, rather than one at random.
  return definitions.filter((definition) => !collisions.has(definition.name));
}
