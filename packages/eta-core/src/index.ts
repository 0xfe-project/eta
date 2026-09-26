/**
 * @eta/core — the kernel's public surface.
 * See REFACTOR.md: cordis bus, three primitives, the runner, and shared types.
 */

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
} from "./kernel/goal.ts";
export { Kernel, type KernelInspect, type KernelOptions } from "./kernel/kernel.ts";
export { PersonaService, renderPersonaBlock } from "./kernel/persona.ts";
export { type ProviderSeam, piAiProviders } from "./kernel/providers.ts";
export {
	isEmptyStop,
	Runner,
	type RunnerBoundaryOptions,
	type RunnerOptions,
	type RunResult,
} from "./kernel/runner.ts";
export { renderCurrentTasks, TaskService } from "./kernel/tasks.ts";
export {
	type BeforeToolResult,
	type KernelTool,
	type ToolCallInfo,
	type ToolMiddleware,
	ToolService,
} from "./kernel/tools.ts";
export { type ForkedChain, type ForkOptions, type ForkSelection, forkChain, selectBranchFork } from "./session/fork.ts";
export { recordGoalEntries } from "./session/goal-journal.ts";
export { EntryGraph, type GraphNode, spliceMergedChain } from "./session/graph.ts";
export { type MergeOptions, type MergeResult, mergeBranch, type RollbackResult, rollback } from "./session/merge.ts";
export { SessionLog } from "./session/session-log.ts";
export { MemoryStorage } from "./storage/memory.ts";
export { InMemoryStorageState } from "./storage/state.ts";
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
} from "./storage/types.ts";
export { assistantMessage, type FakeProvider, fakeProvider, type RecordedCall } from "./testing/fake-provider.ts";
export {
	type StorageContractHandle,
	type StorageContractOptions,
	type StorageFactory,
	storageContract,
} from "./testing/storage-contract.ts";
export * from "./types/entries.ts";
export {
	type ContextPartStats,
	type Emit,
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
	type StorageEvents,
	type TaskEvents,
	type ToolEvents,
	type TurnEvents,
	type UsageEvents,
} from "./types/events.ts";
export type { JsonValue } from "./types/json.ts";
export * from "./types/messages.ts";
export * from "./types/persona.ts";
export * from "./types/tasks.ts";
export { addUsage, emptyUsage, sessionTokenTotal, subtractUsage } from "./types/usage.ts";
