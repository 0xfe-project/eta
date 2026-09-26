/**
 * Compaction — the pure decision and cutting functions (port of eta-agent's
 * harness/compaction/compaction.ts, adapted to the kernel's entry vocabulary).
 *
 * Nothing here summarizes: the model call belongs to the compaction plugin,
 * which gets the runner's context through the two-method seam (§3 ruling 4).
 * What lives here is the arithmetic both sides must agree on — how many tokens
 * a context costs, where a cut may fall, and when a cut is due.
 */
import type { Api, AssistantMessage, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import type { CompactionSettings } from "../types/config";
import type { Entry, MessageEntry } from "../types/entries";
import type { JsonValue } from "../types/json";
import type { AgentMessage, ThinkingLevel } from "../types/messages";

/**
 * The window-independent ceiling (REFACTOR.md, memory #40/#50).
 *
 * Thresholding on `contextWindow - reserveTokens` alone lets a 1M-token model
 * resend nearly a million tokens: slow, expensive, and invisible until the
 * bill arrives. The ceiling caps how much history any single request may
 * carry, whatever the window says. Override per provider through
 * `settings.maxContextTokens`.
 */
export const DEFAULT_MAX_CONTEXT_TOKENS = 64_000;

/** Total context tokens from provider usage. */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function getAssistantUsage(message: AgentMessage): Usage | undefined {
	if (message.role !== "assistant") return undefined;
	const assistant = message as AssistantMessage;
	if (assistant.stopReason === "aborted" || assistant.stopReason === "error") return undefined;
	if (assistant.usage === undefined) return undefined;
	return calculateContextTokens(assistant.usage) > 0 ? assistant.usage : undefined;
}

/** Usage from the last valid assistant message in session entries. */
export function getLastAssistantUsage(entries: Entry[]): Usage | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.type !== "message") continue;
		const usage = getAssistantUsage((entry as MessageEntry).message);
		if (usage !== undefined) return usage;
	}
	return undefined;
}

/** Estimated context-token usage for a message list. */
export interface ContextUsageEstimate {
	/** Estimated total context tokens. */
	tokens: number;
	/** Tokens reported by the most recent assistant usage block. */
	usageTokens: number;
	/** Estimated tokens after the most recent assistant usage block. */
	trailingTokens: number;
	/** Index of the message that provided usage, or null when none exists. */
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: readonly AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const usage = getAssistantUsage(messages[index]!);
		if (usage !== undefined) return { usage, index };
	}
	return undefined;
}

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") return content.length;
	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) chars += block.text.length;
		else if (block.type === "image") chars += ESTIMATED_IMAGE_CHARS;
	}
	return chars;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

/** Estimate token count for one message using the conservative chars/4 heuristic. */
export function estimateTokens(message: AgentMessage): number {
	switch (message.role) {
		case "user":
			return Math.ceil(estimateTextAndImageContentChars(message.content as never) / 4);
		case "assistant": {
			let chars = 0;
			for (const block of (message as AssistantMessage).content) {
				if (block.type === "text") chars += block.text.length;
				else if (block.type === "thinking") chars += block.thinking.length;
				else if (block.type === "toolCall") chars += block.name.length + safeJsonStringify(block.arguments).length;
			}
			return Math.ceil(chars / 4);
		}
		case "toolResult":
			return Math.ceil(estimateTextAndImageContentChars(message.content as never) / 4);
		case "compactionSummary":
			return Math.ceil(message.summary.length / 4);
		case "branchSummary":
			return Math.ceil(message.summary.length / 4);
		default:
			return 0;
	}
}

/** Estimate context tokens for messages, using provider usage when available. */
export function estimateContextTokens(messages: readonly AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);
	if (usageInfo === undefined) {
		let estimated = 0;
		for (const message of messages) estimated += estimateTokens(message);
		return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, lastUsageIndex: null };
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let index = usageInfo.index + 1; index < messages.length; index += 1) {
		trailingTokens += estimateTokens(messages[index]!);
	}
	return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
}

/**
 * Whether context usage has crossed the compaction threshold: the window's
 * reserve, or the absolute ceiling, whichever comes first.
 */
export function shouldCompact(
	contextTokens: number,
	contextWindow: number | undefined,
	settings: CompactionSettings,
): boolean {
	if (!settings.enabled) return false;
	const ceiling = settings.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
	// A model that does not report a window still gets the ceiling: a missing
	// window must not silently switch compaction off.
	const windowThreshold =
		contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0
			? contextWindow - settings.reserveTokens
			: Number.POSITIVE_INFINITY;
	return contextTokens > Math.min(windowThreshold, ceiling);
}

/** Entries a cut may fall on: user/assistant messages and branch summaries. */
function findValidCutPoints(entries: Entry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let index = startIndex; index < endIndex; index += 1) {
		const entry = entries[index]!;
		if (entry.type === "branch_summary") {
			cutPoints.push(index);
			continue;
		}
		if (entry.type !== "message") continue;
		const role = (entry as MessageEntry).message.role;
		// A tool result belongs with the assistant call that produced it: cutting
		// between them would leave the model a result for a call it never made.
		if (role === "user" || role === "assistant") cutPoints.push(index);
	}
	return cutPoints;
}

/** Find the user-visible message that starts the turn containing an entry. */
export function findTurnStartIndex(entries: Entry[], entryIndex: number, startIndex: number): number {
	for (let index = entryIndex; index >= startIndex; index -= 1) {
		const entry = entries[index]!;
		if (entry.type === "branch_summary") return index;
		if (entry.type === "message" && (entry as MessageEntry).message.role === "user") return index;
	}
	return -1;
}

export interface CutPointResult {
	/** Index of the first entry retained after compaction. */
	firstKeptEntryIndex: number;
	/** Index of the turn-start entry when the cut splits a turn, otherwise -1. */
	turnStartIndex: number;
	/** Whether the selected cut point splits an in-progress turn. */
	isSplitTurn: boolean;
}

/** Find the cut point that keeps approximately the requested recent-token budget. */
export function findCutPoint(
	entries: Entry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
	if (cutPoints.length === 0) return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };

	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]!;
	for (let index = endIndex - 1; index >= startIndex; index -= 1) {
		const entry = entries[index]!;
		if (entry.type !== "message") continue;
		accumulatedTokens += estimateTokens((entry as MessageEntry).message);
		if (accumulatedTokens < keepRecentTokens) continue;
		for (const candidate of cutPoints) {
			if (candidate >= index) {
				cutIndex = candidate;
				break;
			}
		}
		break;
	}

	// Never cut in the middle of the non-message run above a message: the entry
	// before the cut has to be a compaction or a message for the replay to read.
	while (cutIndex > startIndex) {
		const previous = entries[cutIndex - 1]!;
		if (previous.type === "compaction" || previous.type === "message") break;
		cutIndex -= 1;
	}

	const cutEntry = entries[cutIndex]!;
	const isUserMessage = cutEntry.type === "message" && (cutEntry as MessageEntry).message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);
	return { firstKeptEntryIndex: cutIndex, turnStartIndex, isSplitTurn: !isUserMessage && turnStartIndex !== -1 };
}

/**
 * Settings written for a large window cannot hold a recent tail as large as a
 * small model's whole context, so a session switched down from a bigger model
 * would compact into a history that still does not fit. The reserve is left
 * alone: a reserve the window cannot afford pushes the threshold earlier,
 * which asks for compaction sooner rather than letting an oversized history
 * through.
 */
export function fitCompactionSettings(
	settings: CompactionSettings,
	model: { contextWindow: number },
): CompactionSettings {
	const windowTokens = model.contextWindow > 0 ? model.contextWindow : 128_000;
	if (windowTokens > settings.keepRecentTokens) return settings;
	return { ...settings, keepRecentTokens: Math.floor(windowTokens / 3) };
}

/* ------------------------------------------------------------------ */
/* The seam                                                            */
/* ------------------------------------------------------------------ */

export type CompactionReason = "manual" | "threshold" | "overflow";

/**
 * What the compaction service is handed. The runner owns the context; the
 * service only gets to read it and hand back a replacement (§3 ruling 4).
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
 * replacement context or declines. The kernel's `CompactionService` owns when
 * to ask (threshold/overflow/manual); this seam owns how to summarize.
 */
export interface CompactionSummarizer {
	summarize(request: CompactionRequest): Promise<CompactionOutcome | undefined>;
}
