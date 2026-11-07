/**
 * Renders a server's tool list and observed output shapes as a d.ts module.
 * Used by eta.mcp.describe and for writing to disk for TypeScript language services.
 */
import type { McpScope } from "./scope";
import { renderOutputShape } from "./output-shape";
import { renderTsShape } from "./ts-shape";

const RESERVED = new Set(["default", "then"]);
const IDENTIFIER = /^[A-Z_$][\w$]*$/i;

function exportable(name: string): boolean {
  return IDENTIFIER.test(name) && !RESERVED.has(name);
}

/**
 * A d.ts for the tools of a server: `declare module "mcp:<server>" { ... }`.
 * Input / output schemas are rendered as TypeScript; observed shapes supplement
 * tools that have no `outputSchema`.
 */
export function describeServerTools(scope: McpScope, server: string): string {
  const def = scope.definition(server);
  if (def === undefined) throw new Error(`MCP server "${server}" not found`);
  const known = scope.tools(server);
  if (known === undefined) return `// Server "${server}" was never discovered.`;
  const lines: string[] = [`declare module "mcp:${server}" {`];
  for (const tool of known) {
    const input = renderTsShape(tool.inputSchema) ?? "unknown";
    let output = "unknown";
    if (tool.outputSchema !== undefined) {
      output = renderTsShape(tool.outputSchema) ?? "unknown";
    } else {
      const observed = scope.observedFor(server, tool);
      if (observed !== undefined && observed.shape !== undefined)
        output = `${renderOutputShape(observed.shape)}`;
    }
    const first =
      (tool.description ?? "").split(/(?<=[.。])\s/)[0]?.trim() ?? "";
    const comment = first ? `/** ${first.replace(/\*\//g, "* /")} */` : "";
    lines.push(
      `  ${comment ? `${comment}\n  ` : ""}export function ${tool.name}(input: ${input}): Promise<${output}>;`,
    );
  }
  const exportable_names = known
    .map((t) => t.name)
    .filter((name) => exportable(name));
  if (exportable_names.length > 0) {
    lines.push(
      `  const exports: { ${exportable_names.map((name) => `${name}: typeof ${name}`).join("; ")} };`,
    );
    lines.push("  export default exports;");
  } else {
    lines.push(
      "  const exports: Record<string, (input: unknown) => Promise<unknown>>;",
    );
    lines.push("  export default exports;");
  }
  lines.push("}");
  return lines.join("\n");
}
