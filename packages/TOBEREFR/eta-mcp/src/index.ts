/**
 * @eta/mcp: MCP for agents, independent of any harness.
 *
 * - `McpManager` holds connections, metadata caches and observed output shapes; `manager.scope()`
 *   gives one owner's view of its servers, from the config sources the caller lists.
 * - `createProxyTool(scope)` is the single `mcp` tool a model sees; `createDirectTools(scope)` are
 *   the tools a config exposes directly. Both are plain `{ name, description, parameters, execute }`.
 * - Hooks (`approve`, `elicit`, `onToolCall`) and `authProviderFor` are injected by the caller.
 */

import type { DirectToolOptions } from "./direct-tools";
import type { McpScope } from "./scope";
import type { McpToolDefinition } from "./types";
import { directToolDefinitions } from "./direct-tools";
import { McpProxy } from "./proxy";

/** The `mcp` proxy tool for a scope. Its description depends only on the configured server names. */
export function createProxyTool(scope: McpScope): McpToolDefinition {
  return new McpProxy(scope).definition();
}

/** Definitions for the `directTools` of a scope's servers, from cached metadata (no connection). */
export function createDirectTools(
  scope: McpScope,
  options?: DirectToolOptions,
): McpToolDefinition[] {
  return directToolDefinitions(scope, options);
}

export { parseMcpServers, resolveServers } from "./config";
export { DeliveryError } from "./delivery";
export type { DirectToolOptions } from "./direct-tools";
export { resolveLaunch } from "./launch";
export type { LaunchCommand, ResolverEnv } from "./launch";
export { McpManager } from "./manager";
export type { McpManagerOptions } from "./manager";
export { directToolName, qualifiedToolName } from "./names";
export * from "./oauth";
export { PROXY_TOOL_NAME } from "./proxy";
export { McpScope, requiresApproval } from "./scope";
export type {
  ConnectOutcome,
  ScopeOptions,
  WarmUpOptions,
  WarmUpResult,
} from "./scope";
export { ServerManager, ServerUnavailableError } from "./server-manager";
export type { Connection, ManagerOptions } from "./server-manager";
export type {
  ApprovalRequest,
  ApproveTools,
  AuthProviderContext,
  AuthProviderFor,
  ContentBlock,
  ElicitationRequest,
  ElicitationResponse,
  McpAuthMode,
  McpConfigSource,
  McpDelivery,
  McpExecuteContext,
  McpHooks,
  McpLifecycle,
  McpServerDefinition,
  McpServerEntry,
  McpToolDefinition,
  McpToolResult,
  ServerState,
  ServerStatus,
  ToolAnnotations,
  ToolCallDecision,
  ToolCallInfo,
  ToolMeta,
} from "./types";
