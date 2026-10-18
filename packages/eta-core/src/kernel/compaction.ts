/**
 * Compaction — the kernel's seam, and nothing else (REFACTOR.md §2.4, §3
 * ruling 4).
 *
 * What the kernel owes compaction is a way to *ask*: the runner hands the
 * context it owns to a `CompactionDriver` and awaits an answer once per run
 * (threshold) or once per overflow. What a driver decides *with* — how many
 * tokens a context costs, where a cut may fall, when a cut is due — is
 * arithmetic, not kernel policy, and lives in `@eta/harness` (`estimation.ts`).
 * What a summary *is* — the prompt, the model call, the folding — belongs to
 * the summarizer plugin behind `CompactionSummarizer`.
 *
 * So this file holds types only. If you are looking for `shouldCompact` or
 * `findCutPoint`, they moved: core does not count tokens.
 */
import type {
  Api,
  AssistantMessage,
  Model,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import type { CompactionSettings } from "../types/config";
import type { Entry } from "../types/entries";
import type { JsonValue } from "../types/json";
import type { AgentMessage, ThinkingLevel } from "../types/messages";

export type CompactionReason = "manual" | "threshold" | "overflow";

/**
 * The run's facts, as a compaction driver needs them; the runner provides them.
 */
export interface CompactionRequestState {
  model: Model<Api> | undefined;
  thinkingLevel: ThinkingLevel;
  streamOptions?: SimpleStreamOptions | undefined;
  /** Aborts the summarization with the run. */
  signal: AbortSignal;
  runId: string;
  /** The model call, wired by whoever owns the models seam. */
  ask: (
    prompt: { systemPrompt?: string; messages: AgentMessage[] },
    options?: { maxTokens?: number; reasoning?: ThinkingLevel },
  ) => Promise<AssistantMessage>;
}

/**
 * What a compaction driver may do to the run in flight; the runner implements
 * it. Three business methods and no storage access: the journal belongs to the
 * journaling service, which a driver asks for entries in its own wiring.
 */
export interface CompactionHost {
  /** The messages a request would carry right now (a copy). */
  readContext(): AgentMessage[];
  /** Swap the context for a summary plus the tail that is kept. */
  replaceContext(
    summary: string,
    options: { retainedTail?: readonly AgentMessage[]; tokensBefore: number },
  ): void;
  /** What this run's request would carry, read live. */
  request(): CompactionRequestState;
}

/**
 * What the kernel asks of compaction, and all it knows about it.
 *
 * The runner calls `attach` once, before the first run, then awaits
 * `threshold()` before its first request of every run and `overflow()` when a
 * request came back too large. A missing driver means no compaction at all —
 * the runner has no fallback arithmetic and no opinion about history size.
 *
 * `false` means "no compaction needed" or "the driver decided not to". A driver
 * that cannot do its job throws: the runner does not catch it, so a half-wired
 * session dies at its first turn instead of running unbounded.
 */
export interface CompactionDriver {
  /** The runner hands over the context it owns, once, before the first run. */
  attach(host: CompactionHost): void;
  /** Compact when the history no longer fits. Awaited before the first request. */
  threshold(): Promise<boolean>;
  /** Recover from an overflowed request. At most once per run. */
  overflow(): Promise<boolean>;
}

/**
 * What the compaction service is handed. The runner owns the context; the
 * service only gets to read it and hand back a replacement.
 */
export interface CompactionRequest {
  reason: CompactionReason;
  /** Extra focus for a manual compaction (`/compact <instructions>`). */
  customInstructions?: string | undefined;
  /** The messages the runner would send right now. */
  messages: readonly AgentMessage[];
  /** The branch entries behind them; cut points are indices into this list. */
  entries: readonly Entry[];
  /** Settings fitted to the model actually in use. */
  settings: CompactionSettings;
  contextWindow: number;
  estimatedTokens: number;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  streamOptions?: SimpleStreamOptions | undefined;
  /** Aborts the summarization request with the run. */
  signal: AbortSignal;
  /** The model call, wired by whoever owns the models seam. */
  ask: (
    prompt: { systemPrompt?: string; messages: AgentMessage[] },
    options?: { maxTokens?: number; reasoning?: ThinkingLevel },
  ) => Promise<AssistantMessage>;
}

export interface CompactionOutcome {
  summary: string;
  /** Whatever the summarizer wants kept alongside the summary (file lists, strategy). */
  details?: JsonValue | undefined;
  /** Messages kept verbatim after the cut. */
  retainedTail: AgentMessage[];
  /** Context tokens before the cut. */
  tokensBefore: number;
  /** What the summarization request cost. */
  usage?: Usage | undefined;
  /** Where the cut fell, when the service used `findCutPoint`. */
  firstKeptEntryIndex?: number | undefined;
}

/**
 * Compaction, as a plugin implements it: one call that either produces a
 * replacement context or declines. Who asks — the harness's compaction service
 * — owns when; this seam owns how to summarize.
 */
export interface CompactionSummarizer {
  summarize(request: CompactionRequest): Promise<CompactionOutcome | undefined>;
}
