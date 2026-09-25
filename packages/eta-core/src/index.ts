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
export { assistantMessage, fakeProvider, type RecordedCall } from "./testing/fake-provider.ts";
export * from "./types/entries.ts";
export {
	type ContextPartStats,
	type Emit,
	type GoalEvents,
	type InjectEvents,
	KERNEL_EVENT_NAMES,
	type KernelEventName,
	type KernelEvents,
	kernelEmit,
	kernelOn,
	type On,
	type PersonaEvents,
	type StorageEvents,
	type TaskEvents,
	type ToolEvents,
	type TurnEvents,
} from "./types/events.ts";
export * from "./types/messages.ts";
export * from "./types/persona.ts";
export * from "./types/tasks.ts";
