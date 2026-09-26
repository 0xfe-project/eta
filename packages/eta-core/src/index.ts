/**
 * @eta/core — the kernel's public surface.
 * See REFACTOR.md: cordis bus, three primitives, the runner, and shared types.
 */

export { type AssistantStreamObserver, consumeAssistantStream } from "./kernel/assistant";
export {
	type CadenceConfig,
	type CadenceState,
	createCadenceState,
	DEFAULT_REMINDER_INTERVAL,
	DEFAULT_TASK_TOOL_NAMES,
	drainReminderForContext,
	evaluateToolResult,
	onTurnStart,
	resetCadenceState,
} from "./kernel/cadence";
export {
	type CompactionOutcome,
	type CompactionReason,
	type CompactionRequest,
	type CompactionSummarizer,
	type ContextUsageEstimate,
	type CutPointResult,
	calculateContextTokens,
	DEFAULT_MAX_CONTEXT_TOKENS,
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	fitCompactionSettings,
	getLastAssistantUsage,
	shouldCompact,
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
export { Kernel, type KernelInspect, type KernelOptions } from "./kernel/kernel";
export { MetricsService } from "./kernel/metrics";
export { MutationQueue } from "./kernel/mutation-queue";
export { type OpenSession, type OpenSessionOptions, openSession } from "./kernel/open";
export { OutputRate } from "./kernel/output-rate";
export { PersonaService, renderPersonaBlock } from "./kernel/persona";
export { type KernelModels, piAiModels } from "./kernel/providers";
export { RunPump, type RunPumpOptions } from "./kernel/pump";
export { TaskReminderService, type TaskReminderServiceOptions } from "./kernel/reminder";
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
	type RunnerOptions,
	type RunResult,
} from "./kernel/runner";
export { renderCurrentTasks, TaskService } from "./kernel/tasks";
export {
	type BeforeToolResult,
	isAbortError,
	type KernelTool,
	type ToolCallInfo,
	type ToolMiddleware,
	ToolService,
} from "./kernel/tools";
export { type ForkedChain, type ForkOptions, type ForkSelection, forkChain, selectBranchFork } from "./session/fork";
export { recordGoalEntries } from "./session/goal-journal";
export { EntryGraph, type GraphNode, spliceMergedChain } from "./session/graph";
export {
	JournalingService,
	type JournalingServiceOptions,
	SESSION_CONFIG,
	TASKS_STATE,
} from "./session/journaling";
export {
	type MergeOptions,
	type MergeResult,
	mergeBranch,
	mergeTip,
	type RollbackResult,
	rollback,
} from "./session/merge";
export { type CommitOutcome, SESSION_TIP, SessionLog } from "./session/session-log";
export { MemoryStorage } from "./storage/memory";
export { InMemoryStorageState } from "./storage/state";
export {
	type BranchScan,
	type CommitResult,
	type CompactResult,
	deleteValue,
	type EntryCursor,
	type EntryScan,
	type RepairResult,
	type SessionStats,
	STORAGE_METHODS,
	type StorageBranchScan,
	type StorageService,
	type StorageWrite,
	type StoredValue,
	setValue,
	type UsageRow,
	type UsageScan,
	type UsageWrite,
	type Value,
	type ValueDeleteWrite,
	type ValueSetWrite,
	type ValueWrite,
	value,
} from "./storage/types";
export {
	assistantMessage,
	type FakeModels,
	type FakeModelsOptions,
	fakeModels,
	type RecordedCall,
} from "./testing/fake-provider";
export {
	type StorageContractHandle,
	type StorageContractOptions,
	type StorageFactory,
	storageContract,
} from "./testing/storage-contract";
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
	type TaskEvents,
	type ToolEvents,
	type TurnEvents,
	type UsageEvents,
} from "./types/events";
export type { JsonValue } from "./types/json";
export * from "./types/messages";
export * from "./types/persona";
export * from "./types/tasks";
export { addUsage, emptyUsage, sessionTokenTotal, subtractUsage } from "./types/usage";
