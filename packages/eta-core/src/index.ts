/**
 * @eta/core — the kernel's public surface.
 * See REFACTOR.md: cordis bus, three primitives, the runner, and shared types.
 */

export {
  type AssistantStreamObserver,
  consumeAssistantStream,
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
export {
  AbortRequested,
  createGate,
  type Gate,
  type GateControl,
} from "./kernel/effect-gate";
export {
  type GenerateOptions,
  type GenerationObserver,
  generateWithRetry,
} from "./kernel/generation";
export {
  ANTI_SPIN_LIMIT,
  applyGoalEntries,
  type GoalBlockedReason,
  type GoalGate,
  GoalService,
  type GoalState,
  type GoalStatus,
  lastMessageShowsIntent,
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
  KERNEL_SERVICE_NAMES,
  Kernel,
  type KernelInspect,
  type KernelOptions,
  sessionScope,
} from "./kernel/kernel";
export { PersonaService } from "./kernel/persona";
export {
  type KernelModels,
  piAiModels,
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
  CONFIG_PROPERTIES,
  type CompactionEconomics,
  type CompactionSettings,
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
  ETA_EVENT_CATEGORIES,
  type EtaEventCategory,
  type GoalEvents,
  type GoalStatusName,
  type InjectEvents,
  KERNEL_EVENT_NAMES,
  type KernelEventName,
  type KernelEvents,
  kernelEmit,
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
