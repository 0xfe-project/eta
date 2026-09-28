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
	type CompactionEntrySource,
	CompactionMisconfigured,
	CompactionService,
	type CompactionServiceOptions,
} from "./compaction-service";
export { MemoryEnvironment, type MemoryEnvironmentOptions, type MemoryShellCall } from "./env/memory";
export { NodeFileSystem, pathExists, resolveEnvPath, toFileError } from "./env/node-fs";
export { killProcessTree, NodeEnvironment, NodeShell, resolveShellConfig, resolveTimeoutMs } from "./env/node-shell";
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
} from "./env/types";
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
export { MetricsService } from "./metrics";
export { type OpenSession, type OpenSessionOptions, openSession } from "./open";
export { OutputBuffer, type OutputBufferOptions } from "./output-capture";
export { RunPump, type RunPumpOptions } from "./pump";
export { TaskReminderService, type TaskReminderServiceOptions } from "./reminder";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
	utf8ByteLength,
} from "./truncate";
