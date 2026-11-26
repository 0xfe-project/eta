/**
 * Standalone CLI entrypoint for the stdio ↔ Streamable HTTP MCP bridge.
 *
 * Spawned in source and test runs by `defaultMcpBridge()`. Compiled `eta-host` and `eta-daemon`
 * binaries execute themselves with the `mcp-bridge` subcommand instead.
 */
import process from "node:process";
import { runMcpBridge } from "./mcp-bridge";

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => controller.abort(signal));

void runMcpBridge({
  args: process.argv.slice(2),
  signal: controller.signal,
}).then((code) => process.exit(code));
