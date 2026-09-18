import {
	SUMMARIZATION_PROMPT,
	SUMMARIZATION_SYSTEM_PROMPT,
	TURN_PREFIX_SUMMARIZATION_PROMPT,
	UPDATE_SUMMARIZATION_PROMPT,
} from "../../prompts/compaction.ts";
export { SUMMARIZATION_SYSTEM_PROMPT };
import { dropToolPairs, untrustedFallback } from "./eta-compaction.ts";
import type { CompactionPreparation, CompactionSettings, FileOperations } from "../session/types.ts";
export type { CompactionPreparation, CompactionSettings, FileOperations } from "../session/types.ts";
import {
	isRetryableAssistantError,
	type Context as AiContext,
	type Api,
	type AssistantMessage,
	contentText,
	type Message,
	type Model,
	type Models,
	type RetryCallbacks,
	type RetryPolicy,
	retryAssistantCall,
	type SimpleStreamOptions,
	type Usage,
	uuidv7,
} from "@earendil-works/pi-ai";
import type { AgentMessage, ThinkingLevel } from "../../types.ts";
import { type Context, getTelemetryContext } from "../context.ts";
import { convertToLlm, createBranchSummaryMessage, createCompactionSummaryMessage } from "../messages.ts";
import { buildContextEntries, sessionEntryToContextMessages } from "../session/context.ts";
import type { CompactionEntry, Entry, JsonValue } from "../session/types.ts";
import { CompactionError, err, ok, type Result } from "../types.ts";
import { addUsage, emptyUsage } from "../utils/usage.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
	serializeConversation,
} from "./utils.ts";

/** File-operation details stored on generated compaction entries. */
export interface CompactionDetails extends Record<string, JsonValue> {
	/** Files read in the compacted history. */
	readFiles: string[];
	/** Files modified in the compacted history. */
	modifiedFiles: string[];
}
function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function extractFileOperations(
	messages: AgentMessage[],
	entries: Entry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (
			typeof prevCompaction.details === "object" &&
			prevCompaction.details !== null &&
			!Array.isArray(prevCompaction.details)
		) {
			if (Array.isArray(prevCompaction.details.readFiles)) {
				for (const path of prevCompaction.details.readFiles) {
					if (typeof path === "string") fileOps.read.add(path);
				}
			}
			if (Array.isArray(prevCompaction.details.modifiedFiles)) {
				for (const path of prevCompaction.details.modifiedFiles) {
					if (typeof path === "string") fileOps.edited.add(path);
				}
			}
		}
	}
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}
function getMessageFromEntry(entry: Entry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message as AgentMessage;
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	if (entry.type === "compaction") {
		return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
	}
	return undefined;
}

function getMessageFromEntryForCompaction(entry: Entry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return getMessageFromEntry(entry);
}

/** Generated compaction data ready to be persisted as a compaction entry. */
export interface CompactResult<T = JsonValue> {
	/** Summary text that replaces compacted history in future context. */
	summary: string;
	/** Estimated context tokens before compaction. */
	tokensBefore: number;
	/** Usage from the LLM call(s) that generated this summary, if available. */
	usage?: Usage;
	/** Retained recent messages stored directly on the compaction entry. */
	retainedTail: AgentMessage[];
	/** Optional implementation-specific details stored with the compaction entry. */
	details?: T;
}

export type SummaryRequest = (
	aiContext: AiContext,
	options: SimpleStreamOptions,
	context: Context,
) => Promise<AssistantMessage>;

export function createSummaryRequestOptions(options: SimpleStreamOptions, context: Context): SimpleStreamOptions {
	return {
		...options,
		signal: context.abortSignal,
		telemetryContext: getTelemetryContext(context),
		cacheRetention: "none",
		sessionId: options.sessionId ?? uuidv7(),
	};
}

export async function completeSimpleWithRetries(
	models: Models,
	model: Model<Api>,
	aiContext: AiContext,
	options: SimpleStreamOptions,
	retry: RetryPolicy | undefined,
	callbacks: RetryCallbacks | undefined,
	context: Context,
): Promise<AssistantMessage> {
	// Summaries are standalone requests, so isolate routing and avoid cache writes that cannot be reused.
	const requestOptions = createSummaryRequestOptions(options, context);
	return retryAssistantCall(
		() => models.completeSimple(model, aiContext, requestOptions),
		retry,
		requestOptions.signal,
		callbacks,
	);
}

/** Compaction thresholds and retention settings. */
/** Default compaction settings used by the harness. */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

/** Calculate total context tokens from provider usage. */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (
			assistantMsg.stopReason !== "aborted" &&
			assistantMsg.stopReason !== "error" &&
			assistantMsg.usage &&
			calculateContextTokens(assistantMsg.usage) > 0
		) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/** Return usage from the last valid assistant message in session entries. */
export function getLastAssistantUsage(entries: Entry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message as AgentMessage);
			if (usage) return usage;
		}
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

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/** Estimate context tokens for messages using provider usage when available. */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/** Return whether context usage exceeds the configured compaction threshold. */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") {
		return content.length;
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			chars = estimateTextAndImageContentChars(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + safeJsonStringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}
function findValidCutPoints(entries: Entry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "compaction":
			case "branch_summary":
			case "custom":
				break;
		}
		if (entry.type === "branch_summary") cutPoints.push(i);
	}
	return cutPoints;
}

/** Find the user-visible message that starts the turn containing an entry. */
export function findTurnStartIndex(entries: Entry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type === "branch_summary") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

/** Cut point selected for compaction. */
export interface CutPointResult {
	/** Index of the first entry retained after compaction. */
	firstKeptEntryIndex: number;
	/** Index of the turn-start entry when the cut splits a turn, otherwise -1. */
	turnStartIndex: number;
	/** Whether the selected cut point splits an in-progress turn. */
	isSplitTurn: boolean;
}

/** Find the compaction cut point that keeps approximately the requested recent-token budget. */
export function findCutPoint(
	entries: Entry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0];

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const messageTokens = estimateTokens(entry.message as AgentMessage);
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			break;
		}
		cutIndex--;
	}
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

/**
 * One summarization request. The conversation crosses the wire as a single user message, which is
 * what makes the model's own window the budget for it.
 */
async function sendSummaryRequest(
	request: SummaryRequest,
	promptText: string,
	model: Model<Api>,
	thinkingLevel: ThinkingLevel | undefined,
	maxTokens: number,
	context: Context,
): Promise<AssistantMessage> {
	const completionOptions =
		model.reasoning && thinkingLevel && thinkingLevel !== "off"
			? { maxTokens, reasoning: thinkingLevel }
			: { maxTokens };
	return request(
		{
			systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: promptText }],
					timestamp: Date.now(),
				},
			],
		},
		createSummaryRequestOptions(completionOptions, context),
		context,
	);
}

function summarizationPromptText(
	conversation: Message[],
	runningSummary: string | undefined,
	instructions: string,
): string {
	let text = `<conversation>\n${serializeConversation(conversation)}\n</conversation>\n\n`;
	if (runningSummary) text += `<previous-summary>\n${runningSummary}\n</previous-summary>\n\n`;
	return text + instructions;
}

/**
 * Compaction settings are written for a large window. A model with a small one cannot hold a
 * recent tail as large as its own context, so a session switched down from a bigger model would
 * compact into a history that still does not fit and overflow the very next request. The reserve
 * is left alone: a reserve the window cannot afford pushes the threshold earlier, which asks for
 * compaction sooner rather than letting an oversized history through, and the summarization request
 * bounds its own prompt whatever the reserve says.
 */
export function fitCompactionSettings(settings: CompactionSettings, model: Model<Api>): CompactionSettings {
	const windowTokens = model.contextWindow > 0 ? model.contextWindow : 128_000;
	if (windowTokens > settings.keepRecentTokens) return settings;
	return { ...settings, keepRecentTokens: Math.floor(windowTokens / 3) };
}

/** Serialized conversation, measured with the chars-per-token rate `estimateTokens` uses. */
function serializedTokens(messages: Message[]): number {
	return Math.ceil(serializeConversation(messages).length / 4);
}

/**
 * How much of the window the conversation may occupy. The reserve is kept for the answer; a
 * reserve larger than the window cannot be honored, so it is clamped to half of the window.
 */
function conversationRoom(model: Model<Api>, reserveTokens: number, promptText: string): number {
	const windowTokens = model.contextWindow > 0 ? model.contextWindow : 128_000;
	const reserve = Math.min(reserveTokens, Math.floor(windowTokens / 2));
	return Math.max(1, windowTokens - reserve - Math.ceil(promptText.length / 4));
}

/** Beyond this many pieces a fold is not worth what it costs; the rest is digested mechanically. */
const SUMMARY_FOLD_LIMIT = 12;

/** Generate or update a conversation summary for compaction. */
export async function generateSummary(
	currentMessages: AgentMessage[],
	models: Models,
	model: Model<Api>,
	reserveTokens: number,
	customInstructions: string | undefined,
	previousSummary: string | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	retry: RetryPolicy | undefined,
	callbacks: RetryCallbacks | undefined,
	context: Context,
): Promise<Result<string, CompactionError>> {
	const result = await generateSummaryWithUsage(
		currentMessages,
		models,
		model,
		reserveTokens,
		customInstructions,
		previousSummary,
		thinkingLevel,
		retry,
		callbacks,
		context,
	);
	return result.ok ? ok(result.value.text) : err(result.error);
}

/** Generate or update a conversation summary and return its provider usage. */
export function generateSummaryWithUsage(
	currentMessages: AgentMessage[],
	models: Models,
	model: Model<Api>,
	reserveTokens: number,
	customInstructions: string | undefined,
	previousSummary: string | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	retry: RetryPolicy | undefined,
	callbacks: RetryCallbacks | undefined,
	context: Context,
): Promise<Result<{ text: string; usage: Usage }, CompactionError>> {
	return generateSummaryWithRequest(
		currentMessages,
		{ model, reserveTokens, customInstructions, previousSummary, thinkingLevel },
		(aiContext, options, requestContext) =>
			completeSimpleWithRetries(models, model, aiContext, options, retry, callbacks, requestContext),
		context,
	);
}

export interface SummaryGenerationOptions {
	model: Model<Api>;
	reserveTokens: number;
	customInstructions?: string;
	previousSummary?: string;
	thinkingLevel?: ThinkingLevel;
}

/** Generate one summary through a caller-owned one-request boundary. */
export async function generateSummaryWithRequest(
	currentMessages: AgentMessage[],
	options: SummaryGenerationOptions,
	request: SummaryRequest,
	context: Context,
): Promise<Result<{ text: string; usage: Usage }, CompactionError>> {
	const { model, reserveTokens, customInstructions, previousSummary, thinkingLevel } = options;
	const maxTokens = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	const instructions = (running: string | undefined): string => {
		const base = running ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
		return customInstructions ? `${base}\n\nAdditional focus: ${customInstructions}` : base;
	};
	const pairs = currentMessages
		.map((message) => ({ agent: message, llm: convertToLlm([message])[0] }))
		.filter((pair): pair is { agent: AgentMessage; llm: Message } => pair.llm !== undefined);

	// A history that grew under one model does not fit the window of a smaller one it was switched
	// to, and the request meant to rescue that window would overflow it first. So the conversation
	// is cut into pieces the window can hold and folded: each piece is summarized against what the
	// earlier pieces already concluded, which is the update path an incremental compaction already
	// uses, only asked for more than once. A history that fits stays one request, with the prompt
	// it used to build.
	const failure = (response: AssistantMessage): Result<never, CompactionError> =>
		err(
			new CompactionError(
				"summarization_failed",
				`Summarization failed: ${response.errorMessage || "Unknown error"}`,
			),
		);
	// A refused piece falls back to a mechanical digest of everything still unsummarized: a worse
	// compaction than the model would have written, and better than losing the turn's history.
	const digestRest = (from: number): string | undefined =>
		untrustedFallback(pairs.slice(from).map((pair) => pair.agent), maxTokens * 4);
	const fold = (text: string | undefined): string => (summary ? `${summary}\n\n${text}` : text ?? "");
	let summary = previousSummary;
	let usage = emptyUsage();
	let cursor = 0;
	let folds = 0;
	do {
		const pieceStart = cursor;
		const room = conversationRoom(
			model,
			reserveTokens,
			summarizationPromptText([], summary, instructions(summary)),
		);
		const piece: Message[] = [];
		let pieceTokens = 0;
		while (cursor < pairs.length) {
			const size = serializedTokens([pairs[cursor].llm]);
			if (piece.length > 0 && pieceTokens + size > room) break;
			piece.push(pairs[cursor].llm);
			pieceTokens += size;
			cursor += 1;
		}
		folds += 1;
		if (cursor < pairs.length && folds >= SUMMARY_FOLD_LIMIT) {
			const digest = digestRest(pieceStart);
			if (digest === undefined)
				return err(new CompactionError("summarization_failed", "Summarization left history without a summary"));
			return ok({ text: fold(digest), usage });
		}
		const response = await sendSummaryRequest(
			request,
			summarizationPromptText(piece, summary, instructions(summary)),
			model,
			thinkingLevel,
			maxTokens,
			context,
		);
		if (response.stopReason === "aborted") {
			return err(new CompactionError("aborted", response.errorMessage || "Summarization aborted"));
		}
		if (response.stopReason === "error") {
			if (isRetryableAssistantError(response)) return failure(response);
			const digest = digestRest(pieceStart);
			if (digest !== undefined) return ok({ text: fold(digest), usage });
			return failure(response);
		}
		summary = contentText(response.content);
		usage = addUsage(usage, response.usage);
	} while (cursor < pairs.length);

	return ok({ text: summary ?? "", usage });
}

/** Prepared inputs for a compaction run. */
/** Prepare session entries for compaction, or return undefined when compaction is not applicable. */
export function prepareCompaction(
	pathEntries: Entry[],
	settings: CompactionSettings,
): Result<CompactionPreparation | undefined, CompactionError> {
	if (pathEntries.length === 0 || pathEntries[pathEntries.length - 1].type === "compaction") {
		return ok(undefined);
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let compactableEntries = pathEntries;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const virtualRetainedEntries: Entry[] = prevCompaction.retainedTail.map((message, index) => ({
			type: "message",
			id: `${prevCompaction.id}:retained:${index}`,
			parentId: index === 0 ? prevCompaction.id : `${prevCompaction.id}:retained:${index - 1}`,
			seq: prevCompaction.seq,
			timestamp: message.timestamp,
			message,
		}));
		compactableEntries = [...virtualRetainedEntries, ...pathEntries.slice(prevCompactionIndex + 1)];
	}
	const boundaryEnd = compactableEntries.length;

	const tokensBefore = estimateContextTokens(
		buildContextEntries(pathEntries).flatMap(sessionEntryToContextMessages),
	).tokens;

	const cutPoint = findCutPoint(compactableEntries, 0, boundaryEnd, settings.keepRecentTokens);
	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	const history: AgentMessage[] = [];
	for (let i = 0; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(compactableEntries[i]);
		if (msg) history.push(msg);
	}
	const messagesToSummarize = dropToolPairs(history);
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(compactableEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}
	const retainedTail: AgentMessage[] = [];
	for (let i = cutPoint.firstKeptEntryIndex; i < boundaryEnd; i++) {
		const msg = getMessageFromEntryForCompaction(compactableEntries[i]);
		if (msg) retainedTail.push(msg);
	}
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return ok({
		messagesToSummarize,
		turnPrefixMessages,
		retainedTail,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	});
}

export { serializeConversation } from "./utils.ts";

/** Generate compaction summary data from prepared session history. */
export function compact(
	preparation: CompactionPreparation,
	models: Models,
	model: Model<Api>,
	customInstructions: string | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	retry: RetryPolicy | undefined,
	callbacks: RetryCallbacks | undefined,
	context: Context,
): Promise<Result<CompactResult, CompactionError>> {
	return compactWithRequest(
		preparation,
		{ model, customInstructions, thinkingLevel },
		(aiContext, options, requestContext) =>
			completeSimpleWithRetries(models, model, aiContext, options, retry, callbacks, requestContext),
		context,
	);
}

export interface CompactGenerationOptions {
	model: Model<Api>;
	customInstructions?: string;
	thinkingLevel?: ThinkingLevel;
}

/** Generate compaction data through a caller-owned boundary for each provider request. */
export async function compactWithRequest(
	preparation: CompactionPreparation,
	options: CompactGenerationOptions,
	request: SummaryRequest,
	context: Context,
): Promise<Result<CompactResult, CompactionError>> {
	const { model, customInstructions, thinkingLevel } = options;
	const {
		messagesToSummarize,
		turnPrefixMessages,
		retainedTail,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	let summary: string;
	let summaryUsage: Usage;

	if (messagesToSummarize.length === 0 && previousSummary !== undefined && turnPrefixMessages.length === 0) {
		// Nothing happened that the notes do not already cover, so the notes stand. Asking the model
		// to rewrite them costs a request and cannot change the answer, and a small window crosses
		// the threshold often enough for that to become a tax on the conversation.
		summary = previousSummary;
		summaryUsage = emptyUsage();
	} else if (isSplitTurn && turnPrefixMessages.length > 0) {
		let historyText = "No prior history.";
		let historyUsage: Usage | undefined;
		if (messagesToSummarize.length > 0) {
			const historyResult = await generateSummaryWithRequest(
				messagesToSummarize,
				{ model, reserveTokens: settings.reserveTokens, customInstructions, previousSummary, thinkingLevel },
				request,
				context,
			);
			if (!historyResult.ok) return err(historyResult.error);
			historyText = historyResult.value.text;
			historyUsage = historyResult.value.usage;
		}
		const turnPrefixResult = await generateTurnPrefixSummary(
			turnPrefixMessages,
			model,
			settings.reserveTokens,
			thinkingLevel,
			request,
			context,
		);
		if (!turnPrefixResult.ok) return err(turnPrefixResult.error);
		summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.value.text}`;
		summaryUsage = historyUsage ? addUsage(historyUsage, turnPrefixResult.value.usage) : turnPrefixResult.value.usage;
	} else {
		const summaryResult = await generateSummaryWithRequest(
			messagesToSummarize,
			{ model, reserveTokens: settings.reserveTokens, customInstructions, previousSummary, thinkingLevel },
			request,
			context,
		);
		if (!summaryResult.ok) return err(summaryResult.error);
		summary = summaryResult.value.text;
		summaryUsage = summaryResult.value.usage;
	}

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);
	const details: CompactionDetails = { readFiles, modifiedFiles };

	return ok({ summary, tokensBefore, usage: summaryUsage, retainedTail, details });
}
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<Api>,
	reserveTokens: number,
	thinkingLevel: ThinkingLevel | undefined,
	request: SummaryRequest,
	context: Context,
): Promise<Result<{ text: string; usage: Usage }, CompactionError>> {
	const maxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const completionOptions =
		model.reasoning && thinkingLevel && thinkingLevel !== "off"
			? { maxTokens, reasoning: thinkingLevel }
			: { maxTokens };
	const response = await request(
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		createSummaryRequestOptions(completionOptions, context),
		context,
	);
	if (response.stopReason === "aborted") {
		return err(new CompactionError("aborted", response.errorMessage || "Turn prefix summarization aborted"));
	}
	if (response.stopReason === "error") {
		return err(
			new CompactionError(
				"summarization_failed",
				`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`,
			),
		);
	}

	return ok({
		text: contentText(response.content),
		usage: response.usage,
	});
}
