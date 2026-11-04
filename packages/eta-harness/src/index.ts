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
  type CompactionEntrySource,
  CompactionMisconfigured,
  CompactionService,
  type CompactionServiceOptions,
} from "./compaction-service";
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
  checkBase64Image,
  checkImage,
  DEFAULT_IMAGE_LIMITS,
  describeImageProblem,
  type ImageLimits,
  imageLimitsFor,
  type ImageProblem,
} from "./image-limits";
export {
  JournalingService,
  type JournalingServiceOptions,
  SESSION_CONFIG,
  TASKS_STATE,
} from "./journaling";
export {
  applyExtraction,
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
  nodeMemoryFs,
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
  DEFAULT_STEP_TOOL_NAMES,
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
  base64ByteLength,
  decodeBase64,
  detectSupportedImageMimeType,
  encodeBase64,
  readImageSize,
} from "./tools/image";
export {
  createStepTools,
  STEP_TOOL_NAMES,
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
  describeRepair,
  repairTranscript,
  type TranscriptRepair,
} from "./transcript-repair";
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
