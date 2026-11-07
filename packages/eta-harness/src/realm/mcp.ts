import type { McpSink, McpToolInfo } from "./hooks";
import type { Realm } from "./realm";
import vm from "node:vm";

export const MCP_PREFIX = "mcp:";
export const MCP_NOT_CONNECTED = "MCP not connected on this machine";

const IDENTIFIER = /^[A-Z_$][\w$]*$/i;
/** Named exports a module cannot have. */
const RESERVED = new Set(["default", "then"]);

/** The functions a script calls for one server: `mcp.<server>.<tool>` bindings. */
function toolFunctions(
  realm: Realm,
  sink: McpSink,
  server: string,
  tools: readonly McpToolInfo[],
): Record<string, (args?: Record<string, unknown>) => Promise<unknown>> {
  const functions: Record<
    string,
    (args?: Record<string, unknown>) => Promise<unknown>
  > = {};
  for (const tool of tools) {
    functions[tool.name] = realm.binding(
      `mcp.${server}.${tool.name}`,
      async (args?: Record<string, unknown>) =>
        realm.own(await sink.callTool(server, tool, args ?? {})),
    );
  }
  return functions;
}

/**
 * `mcp:<server>`: one module per server, every tool an async function taking
 * the tool's arguments as one object. The default export has every tool by its
 * own name; tools named like identifiers are also named exports.
 *
 * Each function is a realm binding, so a call is an effect named
 * `mcp.<server>.<tool>` and goes through the host's authorizer first.
 */
export async function linkMcpModule(
  realm: Realm,
  sink: McpSink | undefined,
  specifier: string,
): Promise<vm.Module> {
  const server = specifier.slice(MCP_PREFIX.length);
  if (sink === undefined)
    throw new Error(`cannot import "${specifier}": ${MCP_NOT_CONNECTED}`);
  const tools = await sink.load(server);
  const functions = toolFunctions(realm, sink, server, tools);
  const named = Object.keys(functions).filter(
    (name) => IDENTIFIER.test(name) && !RESERVED.has(name),
  );
  return new vm.SyntheticModule(
    ["default", ...named],
    function () {
      const object = Object.assign(
        vm.runInContext("({})", realm.context) as object,
        functions,
      );
      this.setExport("default", object);
      for (const name of named) this.setExport(name, functions[name]);
    },
    { context: realm.context, identifier: specifier },
  );
}

/** `eta.mcp`: discovery over cached metadata. None of these start a server. */
export function mcpDiscovery(realm: Realm, sink: McpSink | undefined) {
  const need = (): McpSink => {
    if (sink === undefined) throw new Error(MCP_NOT_CONNECTED);
    return sink;
  };
  return {
    servers: realm.wrap(() =>
      realm.own(
        need()
          .servers()
          .map(({ name, status, toolCount }) => ({ name, status, toolCount })),
      ),
    ),
    search: realm.wrap((query: string) =>
      realm.own(
        need()
          .search(String(query))
          .map(({ server, tool }) => ({
            server,
            tool: tool.name,
            summary: firstSentence(tool.description),
          })),
      ),
    ),
    describe: realm.wrap((server: string) => need().describe(String(server))),
  };
}

function firstSentence(text: string): string {
  const first = (text ?? "").split(/(?<=[.。])\s/)[0]?.trim() ?? "";
  return first.length > 200 ? `${first.slice(0, 197)}...` : first;
}
