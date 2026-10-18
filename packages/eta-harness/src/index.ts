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
  type AskObserver,
  AskRegistry,
  type AskResponse,
  askResponseText,
  askSchema,
  type AskUserToolDeps,
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
  btwSideAsk,
  type BtwSideAskDeps,
  type BtwSideRequest,
  type BtwThread,
  type BtwToolStep,
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
export {
  MemoryEnvironment,
  type MemoryEnvironmentOptions,
  type MemoryShellCall,
} from "./env/memory";
export {
  calculateContextTokens,
  type ContextUsageEstimate,
  type CutPointResult,
  DEFAULT_MAX_CONTEXT_TOKENS,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  findTurnStartIndex,
  fitCompactionSettings,
  getLastAssistantUsage,
  shouldCompact,
} from "./estimation";
export {
  JournalingService,
  type JournalingServiceOptions,
  SESSION_CONFIG,
  TASKS_STATE,
} from "./journaling";
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
  memoryFileLabel,
  type MemoryFs,
  type MemoryLoaded,
  type MemoryScan,
  type MemorySection,
  parseMemory,
  renderMemory,
  renderMemoryBlock,
  scanMemory,
  scanMemoryPaths,
  type TranscriptLike,
} from "./memory";
export { MetricsService } from "./metrics";
export { OutputRate } from "./metrics/output-rate";
export {
  type OpenSession,
  openSession,
  type OpenSessionOptions,
  type SessionMemoryOptions,
} from "./open";
export { dirnameEnvPath, formatSkillInvocation } from "./prompt-blocks";
export * from "./prompts";
export { RunPump, type RunPumpOptions } from "./pump";
export {
  TaskReminderService,
  type TaskReminderServiceOptions,
} from "./reminder";
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
export {
  loadSkills,
  loadSourcedSkills,
  type Skill,
  type SkillDiagnostic,
  type SkillDiagnosticCode,
} from "./skills";
export { MODEL_STATE, sessionStateKV, type StateKV } from "./state";
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
  parsePlan,
  parseReport,
  type Plan,
  PLANNER_PROMPT,
  type PlannerObserver,
  type PlannerReport,
  type PlanTask,
  type PlanTaskRecord,
  type PlanTaskResult,
  type PlanTaskStatus,
  planWaves,
  replan,
  type ReplanOptions,
  runPlan,
  type RunPlanOptions,
  statusesOf,
  type SubagentTaskRunner,
  TASK_REPORT_PROMPT,
  taskPrompt,
  taskSpec,
  validatePlan,
} from "./subagent-plan";
export {
  type BashExecution,
  type BashPrepare,
  bashSchema,
  type BashToolDetails,
  type BashToolInput,
  type BashToolOptions,
  createBashTool,
} from "./tools/bash";
export { executionContext, type ExecutionToolContext } from "./tools/context";
export {
  createEditTool,
  editSchema,
  type EditToolDetails,
  type EditToolInput,
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
  readSchema,
  type ReadToolDetails,
  type ReadToolInput,
  type ReadToolOptions,
} from "./tools/read";
export { createStateTools, stateToolSchemas } from "./tools/state";
export { createSubagentTools, SUBAGENT_TOOL_NAMES } from "./tools/subagents";
export {
  createTaskTools,
  TASK_TOOL_NAMES,
  type TaskStatus,
} from "./tools/tasks";
export {
  defineTool,
  type HarnessTool,
  text,
  toKernelTool,
  toKernelTools,
  toolError,
  type ToolResult,
  type ToolRun,
} from "./tools/tool";
export {
  createWriteTool,
  writeSchema,
  type WriteToolInput,
} from "./tools/write";
export {
  builtinViewContributions,
  queuedText,
  signatureOf,
  streamingBox,
  SYSTEM_ROW_KINDS,
  type SystemRowKind,
  systemRowOf,
  thinkingRows,
  VIEW_MESSAGE_WINDOW,
  type ViewContribution,
  type ViewCore,
  type ViewMessageRow,
  ViewService,
  type ViewServiceOptions,
  type ViewSources,
  type ViewSystemRow,
} from "./view";
export {
  type EnvCallOptions,
  err,
  type ExecutionEnv,
  ExecutionError,
  type ExecutionErrorCode,
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
  truncateHead,
  truncateLine,
  truncateTail,
  type TruncationOptions,
  type TruncationResult,
  utf8ByteLength,
} from "@eta/execution/output";
