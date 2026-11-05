/**
 * @eta/mcp: MCP for agents, independent of any harness.
 *
 * - `McpManager` holds connections, metadata caches and observed output shapes; `manager.scope()`
 *   gives one owner's view of its servers, from the config sources the caller lists.
 * - The model now calls MCP tools via the realm (`import gh from "mcp:github"`), not static proxy tools.
 * - Hooks (`approve`, `elicit`, `onToolCall`) and `authProviderFor` are injected by the caller.
 */

export { parseMcpServers, resolveServers } from "./config";
export { DeliveryError } from "./delivery";

export { describeServerTools } from "./describe";
export { resolveLaunch } from "./launch";
export type { LaunchCommand, ResolverEnv } from "./launch";
export { McpManager } from "./manager";
export type { McpManagerOptions } from "./manager";
export { qualifiedToolName } from "./names";
export * from "./oauth";
export { createMcpRealmAdapter } from "./realm";
export type { McpSink } from "./realm";

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
