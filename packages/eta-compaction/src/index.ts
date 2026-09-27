/**
 * The compaction summarizer (REFACTOR.md §6.2, ported from eta-agent's
 * compaction/compaction.ts + eta-compaction.ts).
 *
 * What it does, in the order it does it:
 *
 * 1. **Cut.** Find the turn boundary that keeps `keepRecentTokens` of recent
 *    history, keeping tool pairs whole. Everything before it gets summarized;
 *    everything after it is retained verbatim.
 * 2. **Drop tool noise.** Past a quarter of the prefix, tool results are dropped
 *    in whole pairs — an assistant call never loses the result it is paired with.
 * 3. **Fold.** Summarize the prefix against what earlier pieces already
 *    concluded. A history that grew under a larger model does not fit the
 *    window of a smaller one, so a single request would overflow the very
 *    window it was meant to protect; the prefix is cut into pieces the window
 *    can hold, each summarized as an update of the running notes.
 * 4. **Digest.** If a piece cannot be summarized, the rest is truncated
 *    max-min-fair and labeled untrusted — worse notes than a model would write,
 *    better than losing the history.
 * 5. **Recut when nothing changed.** If the prefix is empty and the notes
 *    already exist, the notes stand: asking for a rewrite costs a request and
 *    cannot change the answer.
 *
 * The kernel gives it the context and the model call; this package owns the
 * arithmetic, the prompts, and the entry kinds a compaction leaves behind.
 */
import type {
	AgentMessage,
	AssistantMessage,
	CompactionOutcome,
	CompactionRequest,
	CompactionSummarizer,
	Entry,
	MessageEntry,
	Usage,
} from "@eta/core";
import { addUsage, emptyUsage } from "@eta/core";
import { estimateContextTokens, findCutPoint, fitCompactionSettings } from "@eta/harness";
import { digestContext, dropToolPairs } from "./deterministic";
import {
	SUMMARIZATION_PROMPT,
	SUMMARIZATION_SYSTEM_PROMPT,
	TURN_PREFIX_SUMMARIZATION_PROMPT,
	UNTRUSTED_SUMMARY_NOTE,
	UPDATE_SUMMARIZATION_PROMPT,
} from "./prompts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	serializeConversation,
	serializedTokens,
} from "./serialize";

/** Beyond this many pieces a fold is not worth what it costs; the rest is digested mechanically. */
export const SUMMARY_FOLD_LIMIT = 12;

export interface EtaCompactionOptions {
	/** Cap on how many fold requests one compaction may make. Default 12. */
	foldLimit?: number;
}

/** The prepared inputs of one compaction: what to summarize, what to keep. */
export interface CompactionPlan {
	/** History before the cut, tool noise dropped. */
	messagesToSummarize: AgentMessage[];
	/** The early half of a split turn, summarized on its own terms. */
	turnPrefixMessages: AgentMessage[];
	/** History kept verbatim after the cut. */
	retainedTail: AgentMessage[];
	isSplitTurn: boolean;
	tokensBefore: number;
	/** The notes a previous compaction left, when this one replaces them. */
	previousSummary: string | undefined;
	fileOps: FileOperations;
}

const messageOf = (entry: Entry): AgentMessage | undefined =>
	entry.type === "message" ? (entry as MessageEntry).message : undefined;

/**
 * Plan a compaction: where to cut, what to summarize, what to keep.
 *
 * Exported because it is the part worth testing without a model: the cut, the
 * retained tail, and the tool-pair rule are all decidable from the journal.
 */
export function planCompaction(
	request: Pick<CompactionRequest, "entries" | "settings" | "estimatedTokens">,
): CompactionPlan {
	const pathEntries = [...request.entries];
	const settings = request.settings;

	// A previous compaction stands in for the history it replaced: its retained
	// tail plus everything after it is what can be compacted again.
	let previousSummary: string | undefined;
	let compactable: Entry[] = pathEntries;
	let previousIndex = -1;
	for (let index = pathEntries.length - 1; index >= 0; index -= 1) {
		if (pathEntries[index]!.type === "compaction") {
			previousIndex = index;
			break;
		}
	}
	const previousEntry = previousIndex >= 0 ? pathEntries[previousIndex]! : undefined;
	if (previousEntry !== undefined && previousEntry.type === "compaction") {
		previousSummary = previousEntry.summary;
		// The notes stand for the messages they replaced: those messages plus what
		// came after are what a second compaction can work with.
		const retained: Entry[] = previousEntry.retainedTail.map((message, index) => ({
			type: "message",
			id: `${previousEntry.id}:retained:${index}`,
			parentId: index === 0 ? previousEntry.id : `${previousEntry.id}:retained:${index - 1}`,
			seq: previousEntry.seq,
			timestamp: message.timestamp,
			message,
		}));
		compactable = [...retained, ...pathEntries.slice(previousIndex + 1)];
	}

	const end = compactable.length;
	const cut = findCutPoint(compactable, 0, end, settings.keepRecentTokens);
	const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;

	const history: AgentMessage[] = [];
	for (let index = 0; index < historyEnd; index += 1) {
		const message = messageOf(compactable[index]!);
		if (message !== undefined) history.push(message);
	}
	const messagesToSummarize = dropToolPairs(history);

	const turnPrefixMessages: AgentMessage[] = [];
	if (cut.isSplitTurn) {
		for (let index = cut.turnStartIndex; index < cut.firstKeptEntryIndex; index += 1) {
			const message = messageOf(compactable[index]!);
			if (message !== undefined) turnPrefixMessages.push(message);
		}
	}

	const retainedTail: AgentMessage[] = [];
	for (let index = cut.firstKeptEntryIndex; index < end; index += 1) {
		const message = messageOf(compactable[index]!);
		if (message !== undefined) retainedTail.push(message);
	}

	// Files the notes already mention carry forward: a second compaction keeps the
	// lists the first one wrote instead of forgetting them.
	const fileOps = createFileOps();
	if (previousEntry !== undefined && previousEntry.type === "compaction") {
		const details = previousEntry.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
		if (details !== undefined && typeof details === "object" && details !== null && !Array.isArray(details)) {
			if (Array.isArray(details.readFiles)) {
				for (const path of details.readFiles) if (typeof path === "string") fileOps.read.add(path);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const path of details.modifiedFiles) if (typeof path === "string") fileOps.edited.add(path);
			}
		}
	}
	for (const message of [...messagesToSummarize, ...turnPrefixMessages]) extractFileOpsFromMessage(message, fileOps);

	return {
		messagesToSummarize,
		turnPrefixMessages,
		retainedTail,
		isSplitTurn: cut.isSplitTurn,
		// The kernel's own estimate: the same number it decided the threshold on.
		tokensBefore: request.estimatedTokens,
		previousSummary,
		fileOps,
	};
}

/**
 * How much of the window the conversation may occupy. The reserve is kept for
 * the answer; a reserve larger than the window cannot be honored, so it is
 * clamped to half of it.
 */
function conversationRoom(contextWindow: number, reserveTokens: number, promptText: string): number {
	const window = contextWindow > 0 ? contextWindow : 128_000;
	const reserve = Math.min(reserveTokens, Math.floor(window / 2));
	return Math.max(1, window - reserve - Math.ceil(promptText.length / 4));
}

function promptText(
	conversation: readonly AgentMessage[],
	runningSummary: string | undefined,
	instructions: string,
): string {
	let text = `<conversation>\n${serializeConversation(conversation)}\n</conversation>\n\n`;
	if (runningSummary !== undefined && runningSummary.length > 0) {
		text += `<previous-summary>\n${runningSummary}\n</previous-summary>\n\n`;
	}
	return text + instructions;
}

function summaryInstruction(running: string | undefined, custom: string | undefined): string {
	const base = running === undefined || running.length === 0 ? SUMMARIZATION_PROMPT : UPDATE_SUMMARIZATION_PROMPT;
	return custom === undefined || custom.length === 0 ? base : `${base}\n\nAdditional focus: ${custom}`;
}

const aborted = (response: AssistantMessage): boolean => response.stopReason === "aborted";
const failed = (response: AssistantMessage): boolean => response.stopReason === "error";

class SummarizationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SummarizationError";
	}
}

/** One folded summary: the notes, and what writing them cost. */
async function foldSummary(
	request: CompactionRequest,
	conversation: readonly AgentMessage[],
	previousSummary: string | undefined,
	foldLimit: number,
): Promise<{ text: string; usage: Usage } | undefined> {
	const settings = request.settings;
	const maxTokens = Math.min(
		Math.floor(0.8 * settings.reserveTokens),
		request.model.maxTokens > 0 ? request.model.maxTokens : Number.POSITIVE_INFINITY,
	);
	let summary = previousSummary;
	let usage = emptyUsage();
	let cursor = 0;
	let folds = 0;

	// The pieces are sized against the window of the model that will summarize,
	// not the one the history was written under.
	do {
		const pieceStart = cursor;
		const room = conversationRoom(
			request.contextWindow,
			settings.reserveTokens,
			promptText([], summary, summaryInstruction(summary, request.customInstructions)),
		);
		const piece: AgentMessage[] = [];
		let pieceTokens = 0;
		while (cursor < conversation.length) {
			const size = serializedTokens([conversation[cursor]!]);
			if (piece.length > 0 && pieceTokens + size > room) break;
			piece.push(conversation[cursor]!);
			pieceTokens += size;
			cursor += 1;
		}
		folds += 1;

		const digestRest = (): string | undefined => digestContext(conversation.slice(pieceStart), maxTokens * 4);
		if (cursor < conversation.length && folds >= foldLimit) {
			const digest = digestRest();
			if (digest === undefined) throw new SummarizationError("summarization left history without a summary");
			return { text: fold(summary, digest), usage };
		}

		const response = await request.ask(
			{
				systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: promptText(piece, summary, summaryInstruction(summary, request.customInstructions)),
							},
						],
						timestamp: Date.now(),
					},
				],
			},
			{ maxTokens, ...(request.thinkingLevel === "off" ? {} : { reasoning: request.thinkingLevel }) },
		);

		if (aborted(response)) return undefined;
		if (failed(response)) {
			// A refused piece is digested rather than lost: worse notes than a model
			// would write, better than losing the history.
			const digest = digestRest();
			if (digest !== undefined) return { text: fold(summary, digest), usage };
			throw new SummarizationError(`summarization failed: ${response.errorMessage ?? "unknown error"}`);
		}
		summary = textOf(response);
		usage = addUsage(usage, response.usage);
	} while (cursor < conversation.length);

	return { text: summary ?? "", usage };
}

function fold(summary: string | undefined, text: string | undefined): string {
	if (summary === undefined || summary.length === 0) return text ?? "";
	return `${summary}\n\n${text ?? ""}`;
}

function textOf(response: AssistantMessage): string {
	const content = (response as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as { type?: string; text?: string }[])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

/** The early half of a split turn, noted on its own terms. */
async function foldTurnPrefix(
	request: CompactionRequest,
	messages: readonly AgentMessage[],
): Promise<{ text: string; usage: Usage } | undefined> {
	const maxTokens = Math.min(
		Math.floor(0.5 * request.settings.reserveTokens),
		request.model.maxTokens > 0 ? request.model.maxTokens : Number.POSITIVE_INFINITY,
	);
	const prompt = `<conversation>\n${serializeConversation(messages)}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	const response = await request.ask(
		{
			systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		},
		{ maxTokens, ...(request.thinkingLevel === "off" ? {} : { reasoning: request.thinkingLevel }) },
	);
	if (aborted(response)) return undefined;
	if (failed(response)) {
		throw new SummarizationError(`turn prefix summarization failed: ${response.errorMessage ?? "unknown error"}`);
	}
	return { text: textOf(response), usage: response.usage };
}

/**
 * The summarizer the kernel's CompactionService calls.
 *
 * It never throws for a decision the caller can act on: an aborted
 * summarization declines (the run it belonged to is being cancelled), and a
 * summarization that cannot produce notes is either digested or reported as a
 * failure the service records.
 */
export function etaCompaction(options: EtaCompactionOptions = {}): CompactionSummarizer {
	const foldLimit = options.foldLimit ?? SUMMARY_FOLD_LIMIT;
	return {
		async summarize(request: CompactionRequest): Promise<CompactionOutcome | undefined> {
			// Nothing to compact is a decline, not a request: asking a model to
			// summarize an empty conversation spends money on an answer that cannot
			// say anything (eta-agent's `prepareCompaction` guard).
			if (request.entries.length === 0 || request.entries[request.entries.length - 1]?.type === "compaction") {
				return undefined;
			}
			// The settings are fitted to the model actually in use: a session switched
			// down to a smaller window keeps a tail that window can hold.
			const plan = planCompaction({
				entries: request.entries,
				settings: fitCompactionSettings(request.settings, request.model),
				estimatedTokens: request.estimatedTokens,
			});

			let summary: string;
			let usage: Usage;
			if (
				plan.messagesToSummarize.length === 0 &&
				plan.turnPrefixMessages.length === 0 &&
				plan.previousSummary === undefined
			) {
				// The keep budget covers everything: there is no history to replace.
				return undefined;
			}
			if (
				plan.messagesToSummarize.length === 0 &&
				plan.previousSummary !== undefined &&
				plan.turnPrefixMessages.length === 0
			) {
				// Nothing happened that the notes do not already cover, so the notes
				// stand. Asking for a rewrite costs a request and cannot change them.
				summary = plan.previousSummary;
				usage = emptyUsage();
			} else if (plan.isSplitTurn && plan.turnPrefixMessages.length > 0) {
				let historyText = "No prior history.";
				let historyUsage: Usage | undefined;
				if (plan.messagesToSummarize.length > 0) {
					const folded = await foldSummary(request, plan.messagesToSummarize, plan.previousSummary, foldLimit);
					if (folded === undefined) return undefined;
					historyText = folded.text;
					historyUsage = folded.usage;
				}
				const prefix = await foldTurnPrefix(request, plan.turnPrefixMessages);
				if (prefix === undefined) return undefined;
				summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${prefix.text}`;
				usage = historyUsage === undefined ? prefix.usage : addUsage(historyUsage, prefix.usage);
			} else {
				const folded = await foldSummary(request, plan.messagesToSummarize, plan.previousSummary, foldLimit);
				if (folded === undefined) return undefined;
				summary = folded.text;
				usage = folded.usage;
			}

			// What the history touched, appended where the next reader sees it.
			const { readFiles, modifiedFiles } = computeFileLists(plan.fileOps);
			const text = summary + formatFileOperations(readFiles, modifiedFiles);
			return {
				summary: text.length === 0 ? UNTRUSTED_SUMMARY_NOTE : text,
				retainedTail: plan.retainedTail,
				tokensBefore: plan.tokensBefore,
				usage,
				...(readFiles.length === 0 && modifiedFiles.length === 0 ? {} : { details: { readFiles, modifiedFiles } }),
			};
		},
	};
}

/** The default summarizer: what a session gets when the host wires none itself. */
export const defaultCompactionSummarizer = etaCompaction();

/** Estimated tokens a message list costs, with the kernel's own arithmetic. */
export const contextTokensOf = (messages: readonly AgentMessage[]): number => estimateContextTokens(messages).tokens;

export {
	digestContext,
	dropToolPairs,
	maxMinFairAllocations,
	TOOL_MESSAGE_DROP_THRESHOLD,
	toolResultShare,
	truncateFairly,
	untrustedFallback,
} from "./deterministic";
export {
	SUMMARIZATION_PROMPT,
	SUMMARIZATION_SYSTEM_PROMPT,
	TURN_PREFIX_SUMMARIZATION_PROMPT,
	UNTRUSTED_SUMMARY_NOTE,
	UPDATE_SUMMARIZATION_PROMPT,
} from "./prompts";
export {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	serializeConversation,
	serializedTokens,
} from "./serialize";
