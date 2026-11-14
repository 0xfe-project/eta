/**
 * @eta/core — the kernel's public surface.
 * See REFACTOR.md: cordis bus, three primitives, the runner, and shared types.
 */

export {
  type AssistantStreamObserver,
  consumeInterruptibleStream,
  type InterruptibleStreamObserver,
  STOP_STREAM,
} from "./kernel/assistant";
export type {
  CompactionDriver,
  CompactionHost,
  CompactionOutcome,
  CompactionReason,
  CompactionRequest,
  CompactionRequestState,
  CompactionSummarizer,
} from "./kernel/compaction";
export {
  ConfigService,
  RETRY_DEFAULTS,
  validateCompactionSettings,
  validateKernelConfig,
  validateRetryPolicy,
  validateToolNames,
} from "./kernel/config";
export type {
  DelegatedRunResult,
  RunDelegate,
  RunDelegateContext,
} from "./kernel/delegate";
export {
  DEFAULT_MAX_INTERRUPTS,
  type GenerateOptions,
  generateWithRetry,
  type GenerationInterrupt,
  type GenerationObserver,
} from "./kernel/generation";
export {
  ANTI_SPIN_LIMIT,
  applyGoalEntries,
  type GoalBlockedReason,
  type GoalGate,
  GoalService,
  type GoalState,
  type GoalStatus,
  MAX_CONTINUATIONS,
} from "./kernel/goal";
export {
  Inbox,
  type InboxOptions,
  InvalidMessage,
  type InvalidMessageReason,
  normalizeQueuedInput,
  type QueuedItem,
  type QueueKind,
} from "./kernel/inbox";
export {
  Kernel,
  KERNEL_SERVICE_NAMES,
  type KernelInspect,
  type KernelOptions,
  sessionScope,
} from "./kernel/kernel";
export { PersonaService } from "./kernel/persona";
export {
  type KernelModels,
  THINKING_LEVELS,
  thinkingLevelsFor,
} from "./kernel/providers";
export {
  type AgentRetryPolicy,
  DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
  DEFAULT_RETRY_POLICY,
  type NormalizedRetryPolicy,
  normalizedRetryPolicy,
  retryDelayMs,
  retryNotBefore,
  waitUntil,
} from "./kernel/retry";
export {
  type GenerationFrame,
  type GenerationVerdict,
  isEmptyStop,
  type RequestState,
  Runner,
  type RunnerBoundaryOptions,
  type RunnerJournal,
  type RunnerOptions,
  type RunResult,
  toToolResultMessage,
} from "./kernel/runner";
export { TaskService } from "./kernel/tasks";
export {
  type BeforeToolResult,
  isAbortError,
  type KernelTool,
  type ToolCallInfo,
  type ToolMiddleware,
  ToolService,
  type ToolUpdateOptions,
} from "./kernel/tools";
// Compatibility exports; new consumers should use the focused subpaths.
export * from "./session/index";
export * from "./storage/index";
export {
  type CompactionEconomics,
  type CompactionSettings,
  CONFIG_PROPERTIES,
  type ConfigProperty,
  DEFAULT_COMPACTION_ECONOMICS,
  DEFAULT_COMPACTION_SETTINGS,
  defaultKernelConfig,
  type KernelConfig,
  type ModelConfig,
  type ModelIdentity,
  type QueueMode,
  type RuntimeConfig,
  type ToolExecution,
} from "./types/config";
export * from "./types/entries";
export {
  type CompactionEvents,
  type ContextPartStats,
  type Emit,
  type EntryEvents,
  type GoalEvents,
  type GoalStatusName,
  type InjectEvents,
  kernelEmit,
  type KernelEvents,
  kernelOn,
  type MessageEvents,
  type On,
  type PersonaEvents,
  type PromptEvents,
  type StateEvents,
  type StorageEvents,
  type SubagentEvents,
  type TaskEvents,
  type ToolEvents,
  type TurnEvents,
  type UsageEvents,
} from "./types/events";
export type { JsonValue } from "./types/json";
export * from "./types/messages";
export * from "./types/persona";
export * from "./types/tasks";
export {
  addUsage,
  emptyUsage,
  sessionTokenTotal,
  subtractUsage,
} from "./types/usage";
