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
	CompactionService,
	type CompactionServiceOptions,
} from "./compaction-service";
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
