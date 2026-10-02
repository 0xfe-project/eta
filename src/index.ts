/**
 * @eta/harness — the default minimal runnable set.
 *
 * The kernel (`@eta/core`) is the floor: the bus, the primitives, the runner,
 * the session semantics, and the seams. The harness is everything a session
 * needs to actually run, layered on top of that floor:
 *
 * - `JournalingService` — the journal's real owner, fed by the bus.
 * - `CompactionService` — the compaction driver the runner awaits.
 * - `MetricsService`, `TaskReminderService`, `RunPump` — the rest of the battery.
 * - `openSession` — the one call that assembles a session.
 *
 * Absence is expressed at the plugin layer, never by leaving harness pieces
 * out: installing the harness installs all of it.
 */

export {
	type EnvCallOptions,
	type ExecutionEnv,
	ExecutionError,
	type ExecutionErrorCode,
	err,
	FileError,
	type FileErrorCode,
	type FileInfo,
	type FileKind,
	type FileSystem,
	getOrThrow,
	getOrUndefined,
	ok,
	type Result,
	type Shell,
	type ShellExecOptions,
	type ShellExecResult,
	type ShellOutputLimits,
	type ShellTruncation,
	type TextLine,
	type TextLineReader,
} from "@eta/execution";
export {
	AdaptivePublisher,
	type AdaptivePublisherOptions,
	applyShellOutputUpdate,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	LiveOutput,
	type LiveOutputOptions,
	OUTPUT_MIN_EMIT_INTERVAL_MS,
	OUTPUT_TARGET_BYTES_PER_SECOND,
	OutputBuffer,
	type OutputBufferOptions,
	sanitizeShellOutput,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
	utf8ByteLength,
} from "@eta/execution/output";
export {
	type AskObserver,
	AskRegistry,
	type AskResponse,
	type AskUserToolDeps,
	askResponseText,
	askSchema,
	createAskUserTool,
	type HeadlessAsk,
	normalizeAskOptions,
} from "./ask";
export {
	type BtwBuildContext,
	type BtwExchange,
	BtwManager,
	type BtwManagerOptions,
	type BtwSaveState,
	type BtwSideAnswer,
	type BtwSideAsk,
	type BtwSideAskDeps,
	type BtwSideRequest,
	type BtwThread,
	type BtwToolStep,
	btwSideAsk,
	handoffText,
	SIDE_EXCLUDED_TOOLS,
	SIDE_MAX_TOKENS,
	SIDE_MAX_TOOL_TURNS,
	SIDE_TOKEN_BUDGET,
} from "./btw";
export {
	type CompactionEntrySource,
	CompactionMisconfigured,
	CompactionService,
	type CompactionServiceOptions,
} from "./compaction-service";
export { MemoryEnvironment, type MemoryEnvironmentOptions, type MemoryShellCall } from "./env/memory";
export {
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
} from "./estimation";
export { JournalingService, type JournalingServiceOptions, SESSION_CONFIG, TASKS_STATE } from "./journaling";
export {
	applyExtraction,
	envMemoryFs,
	extractionTranscript,
	extractMemory,
	extractMemoryAtRunEnd,
	MEMORY_CAP,
	MEMORY_FILE,
	MEMORY_SECTIONS,
	MEMORY_TRANSCRIPT_CAP,
	type MemoryCache,
	type MemoryEntry,
	type MemoryExtraction,
	type MemoryExtractionOutcome,
	type MemoryExtractionSource,
	type MemoryFile,
	type MemoryFs,
	type MemoryLoaded,
	type MemoryScan,
	type MemorySection,
	memoryFileLabel,
	parseMemory,
	renderMemory,
	renderMemoryBlock,
	scanMemory,
	scanMemoryPaths,
	type TranscriptLike,
} from "./memory";
export { MetricsService } from "./metrics";
export { OutputRate } from "./metrics/output-rate";
export { type OpenSession, type OpenSessionOptions, openSession, type SessionMemoryOptions } from "./open";
export { dirnameEnvPath, formatSkillInvocation } from "./prompt-blocks";
export * from "./prompts";
export { RunPump, type RunPumpOptions } from "./pump";
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
} from "./reminder/cadence";
export { TaskReminderService, type TaskReminderServiceOptions } from "./reminder";
export {
	loadSkills,
	loadSourcedSkills,
	type Skill,
	type SkillDiagnostic,
	type SkillDiagnosticCode,
} from "./skills";
export { MODEL_STATE, type StateKV, sessionStateKV } from "./state";
export {
	DEFAULT_POOL_SIZE,
	DEPTH_CAP,
	type SubagentApi,
	type SubagentBus,
	type SubagentEventName,
	SubagentManager,
	type SubagentRecord,
	type SubagentRunner,
	type SubagentSpec,
	type SubagentStatus,
	type SubagentUsage,
} from "./subagent";
export {
	asReport,
	extractJsonBlock,
	PLANNER_PROMPT,
	type Plan,
	type PlannerObserver,
	type PlannerReport,
	type PlanTask,
	type PlanTaskRecord,
	type PlanTaskResult,
	type PlanTaskStatus,
	parsePlan,
	parseReport,
	planWaves,
	type ReplanOptions,
	type RunPlanOptions,
	replan,
	runPlan,
	type SubagentTaskRunner,
	statusesOf,
	TASK_REPORT_PROMPT,
	taskPrompt,
	taskSpec,
	validatePlan,
} from "./subagent-plan";
export {
	type BashExecution,
	type BashPrepare,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	bashSchema,
	createBashTool,
} from "./tools/bash";
export { type ExecutionToolContext, executionContext } from "./tools/context";
export {
	createEditTool,
	type EditToolDetails,
	type EditToolInput,
	editSchema,
	prepareEditArguments,
} from "./tools/edit";
export {
	applyEditsToNormalizedContent,
	type Edit,
	generateDiffString,
	generateUnifiedPatch,
} from "./tools/edit-diff";
export { withFileMutationQueue } from "./tools/file-mutation-queue";
export { detectSupportedImageMimeType, encodeBase64 } from "./tools/image";
export { resolveReadToolPath, resolveToolPath } from "./tools/path-utils";
export {
	createReadTool,
	type ReadImageProcessor,
	type ReadImageProcessorResult,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
	readSchema,
} from "./tools/read";
export { createStateTools, stateToolSchemas } from "./tools/state";
export { createSubagentTools, SUBAGENT_TOOL_NAMES } from "./tools/subagents";
export { createTaskTools, TASK_TOOL_NAMES, type TaskStatus } from "./tools/tasks";
export {
	defineTool,
	type HarnessTool,
	type ToolResult,
	type ToolRun,
	text,
	toKernelTool,
	toKernelTools,
	toolError,
} from "./tools/tool";
export { createWriteTool, type WriteToolInput, writeSchema } from "./tools/write";
export {
	builtinViewContributions,
	queuedText,
	SYSTEM_ROW_KINDS,
	type SystemRowKind,
	signatureOf,
	streamingBox,
	thinkingRows,
	VIEW_MESSAGE_WINDOW,
	type ViewContribution,
	type ViewCore,
	type ViewMessageRow,
	ViewService,
	type ViewServiceOptions,
	type ViewSources,
} from "./view";
