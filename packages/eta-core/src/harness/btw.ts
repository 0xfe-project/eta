/**
 * btw: a temporary conversation beside a busy session. The case it exists for is a
 * run that cannot be interrupted — a loop or a goal driving itself — while the user
 * wants something looked up or done now. So a thread is answered by a standalone
 * request: it takes no lane slot, holds no run, and lands while the main agent is
 * mid-turn. It owns no configuration either: the model, the thinking level, the
 * active tools and the system prompt are the main agent's, read at the moment the
 * question is asked, which is what keeps a side request honest about a session whose
 * model or toolset changed underneath it.
 *
 * A thread is also a note pad. Recorded notes can be saved into the main session as
 * plain user/assistant pairs (one transcript model, no second one) or handed to the
 * main run as a follow-up, the same driver goals and loops use. Persistence rides
 * `eta.btw` CustomEntries.
 */

import type { AssistantMessage, Models, SimpleStreamOptions, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentToolCall, ThinkingLevel } from "../types.ts";
import type { Context as LaneContext } from "./context.ts";
import type { EtaEmit } from "./events.ts";
import { applyStreamOptionsPatch } from "./hooks.ts";
import { completeSimpleWithRetries, createSummaryRequestOptions } from "./compaction/compaction.ts";
import { convertToLlm } from "./messages.ts";
import type { BtwPayload } from "./session/types.ts";
import type { AgentHarnessStreamOptions, AgentHarnessStreamOptionsPatch } from "./types.ts";
import type { LaneRequestState } from "./runtime/types.ts";
import { addUsage } from "./utils/usage.ts";

export type BtwSaveState = "not-saved" | "queued" | "saved";

/** A tool a side request ran, kept so the answer can say how it was reached. */
export interface BtwToolStep {
	tool: string;
	ok: boolean;
	at: number;
}

export interface BtwExchange {
	question: string;
	answer: string;
	at: number;
	/** Set when a side request ran tools to get the answer; absent means nothing was looked up. */
	steps?: BtwToolStep[];
}

export interface BtwThread {
	id: string;
	kind: "contextual" | "tangent";
	exchanges: BtwExchange[];
	saveState: BtwSaveState;
	/** Set from the moment a question is asked until the side request resolves. */
	pending?: { question: string; at: number };
	/** Why the last question did not get an answer; cleared by the next one. */
	error?: string;
}

type BuildContext = (entries: unknown[], leafId: string | null) => { messages: AgentMessage[] };

const NO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function sideUser(text: string, at: number): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: at } as AgentMessage;
}

/**
 * A recorded note as the provider path wants it: content blocks and an assistant
 * role, so the side thread goes out through the same adapters the main one does.
 */
function sideAssistant(text: string, at: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "unknown",
		provider: "unknown",
		model: "btw",
		usage: NO_USAGE,
		stopReason: "stop",
		timestamp: at,
	} as unknown as AgentMessage;
}

/** Legacy CustomEntry-shaped btw notes; first-class `btw` entries carry no message. */
function isVisibleBtw(entry: unknown): boolean {
	const e = entry as { role?: string; customType?: string };
	return e?.role === "custom" && e.customType === "eta.btw";
}

/** What handoff hands the main run: the notes, as a follow-up it can fold in. */
function handoffText(id: string, exchanges: readonly BtwExchange[]): string {
	return [
		`[btw ${id}] notes taken beside the run:`,
		exchanges
			.map((exchange) =>
				exchange.answer.length === 0 ? `- ${exchange.question}` : `- ${exchange.question} -> ${exchange.answer}`,
			)
			.join("\n"),
		"Fold these in or summarize them for the user.",
	].join("\n");
}

/** One side request: the thread's own history plus the new question. */
export interface BtwSideRequest {
	threadId: string;
	kind: BtwThread["kind"];
	question: string;
	/** Seed plus recorded notes, in order — everything the thread already knows. */
	messages: AgentMessage[];
}

/** What a side request gives back: the answer, what it cost, and what it ran. */
export interface BtwSideAnswer {
	text: string;
	usage: Usage;
	steps: BtwToolStep[];
}

/** How a thread gets answered: a bounded request-and-tools round, no lane, no run. */
export type BtwSideAsk = (request: BtwSideRequest) => Promise<BtwSideAnswer>;

export interface BtwSideAskDeps {
	models: Models;
	/**
	 * The main agent's request state as of now — model, thinking level, tool
	 * declarations, system prompt, tool context. Read per request, never cached, so
	 * a side request inherits a model or toolset switch the moment it happens.
	 */
	requestState: () => Promise<LaneRequestState<object | undefined> | undefined>;
	/**
	 * Run one tool call through the main agent's `before_tool`/`after_tool` pipeline
	 * and effect gate, under the tool context the prompt was built with. A tool
	 * failure arrives as an error result, so the side model sees it as a failed tool
	 * rather than a crashed request.
	 */
	executeTool: (
		call: AgentToolCall,
		info: { threadId: string; toolContext: unknown; turn: number },
	) => Promise<ToolResultMessage>;
	/** The `before_request` hook, run per turn with the same tool context a run uses. */
	beforeRequest?: (info: {
		threadId: string;
		turn: number;
		model: LaneRequestState<object | undefined>["model"];
		streamOptions?: AgentHarnessStreamOptions;
	}) => Promise<AgentHarnessStreamOptionsPatch | undefined>;
	context: LaneContext;
	/** A side answer is real spend; the agent records it against the session. */
	onUsage?: (usage: Usage, threadId: string) => void;
}

/**
 * Output cap per request and across one question. A tool loop re-sends the thread
 * each turn, so without a shared ceiling the turns add up instead of bounding
 * anything.
 */
const SIDE_MAX_TOKENS = 1024;
const SIDE_TOKEN_BUDGET = 4096;
/** Turns one question may spend on tools before the answer is demanded. */
const SIDE_MAX_TOOL_TURNS = 4;

/**
 * The tool a side request never inherits. `ask_user` waits for a human, and the GUI
 * has one question slot that the main run owns — a side request that asked would
 * either steal it from the run it was meant to work beside or hang until timeout,
 * which is the opposite of a channel that answers in seconds.
 */
const SIDE_EXCLUDED_TOOLS = new Set(["ask_user"]);

/**
 * The stock side ask: a bounded request-and-tools round on the lane's own model,
 * prompt and tools. Text-level failure becomes a rejected promise so the thread
 * records `error`, not a fake answer that would replay forever.
 */
export function btwSideAsk(deps: BtwSideAskDeps): BtwSideAsk {
	return async (request) => {
		const state = await deps.requestState();
		if (state === undefined) throw new Error("no session to inherit the side request from");
		const model = state.model;
		if (model === undefined) throw new Error("no model configured for this session");
		const tools = state.tools.filter((tool) => !SIDE_EXCLUDED_TOOLS.has(tool.name));
		const skipped = state.missingToolNames.filter((name) => !SIDE_EXCLUDED_TOOLS.has(name));
		const messages: AgentMessage[] = [...request.messages, sideUser(request.question, Date.now())];
		const steps: BtwToolStep[] = [];
		let usage = NO_USAGE;
		let budget = SIDE_TOKEN_BUDGET;
		let text = "";

		for (let turn = 0; ; turn++) {
			const patch = await deps
				.beforeRequest?.({ threadId: request.threadId, turn, model: state.model, streamOptions: state.streamOptions })
				.catch(() => undefined);
			const response = await completeSimpleWithRetries(
				deps.models,
				model,
				{
					systemPrompt: state.systemPrompt,
					messages: convertToLlm(messages),
					...(tools.length === 0 ? {} : { tools }),
				},
				sideRequestOptions(state, deps.context, Math.min(SIDE_MAX_TOKENS, budget), patch),
				state.retryPolicy,
				undefined,
				deps.context,
			);
			usage = addUsage(usage, response.usage);
			// The budget is what the whole question cost, not what its last turn cost.
			budget -= response.usage.totalTokens;
			text = textOf(response);
			const calls = response.content.filter((part) => part.type === "toolCall");
			if (response.stopReason === "error") {
				throw new Error(response.errorMessage ?? "the side request failed");
			}
			if (calls.length === 0 || turn >= SIDE_MAX_TOOL_TURNS || budget <= 0) {
				// Out of room to keep going: say what is known rather than nothing. The
				// tools already run are real, so a stopped answer is still the truth.
				if (calls.length > 0) {
					text = [
						text,
						`(the side request stopped at ${calls.length} pending tool calls: its turn or token budget ran out)`,
					]
						.filter((part) => part.length > 0)
						.join("\n");
				}
				break;
			}
			messages.push(response);
			for (const call of calls) {
				const result = await deps.executeTool(
					{ id: call.id, name: call.name, arguments: call.arguments } as AgentToolCall,
					{ threadId: request.threadId, toolContext: state.toolContext, turn },
				);
				steps.push({ tool: call.name, ok: !result.isError, at: Date.now() });
				messages.push(result);
			}
		}
		// An active tool the session never defined would have made a run fail. Here the
		// request still answers, with the gap admitted — a temporary window that
		// refuses to answer over a bookkeeping mismatch is not worth the deadlock.
		const note = skipped.length === 0 ? "" : `\n(unavailable this time: ${skipped.join(", ")})`;
		const answer = text.length === 0 ? "(the side request returned no text)" : text + note;
		deps.onUsage?.(usage, request.threadId);
		return { text: answer, usage, steps };
	};
}

/** Request options for one side turn: the lane's stream options, this turn's cap, and
 * whatever a `before_request` hook added — merged by the same function a run uses, so a
 * hook's header or metadata patch behaves here exactly as it does mid-run. */
function sideRequestOptions(
	state: LaneRequestState<object | undefined>,
	context: LaneContext,
	maxTokens: number,
	patch: AgentHarnessStreamOptionsPatch | undefined,
): SimpleStreamOptions {
	const merged = applyStreamOptionsPatch(state.streamOptions ?? {}, patch ?? {});
	const options = createSummaryRequestOptions(
		{
			...merged,
			maxTokens,
			...(state.thinkingLevel === "off" ? {} : { reasoning: state.thinkingLevel }),
		},
		context,
	);
	// A side request repeats its seed on every turn of its tool loop, so if the session
	// asked for cache retention, honour it: without it the second turn pays full price
	// for the first turn's prefix.
	return merged.cacheRetention === undefined ? options : { ...options, cacheRetention: merged.cacheRetention };
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => ("text" in part ? part.text : ""))
		.join("\n")
		.trim();
}

export class BtwManager {
	private threads = new Map<string, BtwThread>();
	private sequence = 0;
	/** Seed cache per thread; contextual threads rebuild it from entries. */
	private seeds = new Map<string, AgentMessage[]>();

	private readonly buildContext: BuildContext;
	private readonly onVisibleNote?: (note: string) => void | Promise<void>;
	private readonly observe: EtaEmit | undefined;
	private readonly sideAsk: BtwSideAsk | undefined;

	constructor(
		buildContext: BuildContext,
		onVisibleNote?: (note: string) => void | Promise<void>,
		observe?: EtaEmit,
		sideAsk?: BtwSideAsk,
	) {
		this.buildContext = buildContext;
		this.onVisibleNote = onVisibleNote;
		this.observe = observe;
		this.sideAsk = sideAsk;
	}

	create(kind: BtwThread["kind"]): BtwThread {
		const thread: BtwThread = {
			id: `btw-${++this.sequence}`,
			kind,
			exchanges: [],
			saveState: "not-saved",
		};
		this.threads.set(thread.id, thread);
		this.observe?.("btw", "opened", { threadId: thread.id, kind: thread.kind });
		return thread;
	}

	get(id: string): BtwThread | undefined {
		return this.threads.get(id);
	}

	list(): BtwThread[] {
		return [...this.threads.values()];
	}

	/** Seed = main-session context without any visible btw message; on context
	 * failure fall back to visible entries directly (both branches from pi-btw). */
	seedFrom(threadId: string, entries: unknown[], leafId: string | null): void {
		const thread = this.threads.get(threadId);
		if (thread === undefined || thread.kind !== "contextual") return;
		try {
			this.seeds.set(
				threadId,
				this.buildContext(entries, leafId).messages.filter((m) => !isVisibleBtw(m)),
			);
		} catch {
			this.seeds.set(
				threadId,
				entries.filter(
					(e) =>
						typeof (e as { role?: unknown }).role === "string" &&
						Array.isArray((e as { content?: unknown }).content) &&
						!isVisibleBtw(e),
				) as AgentMessage[],
			);
		}
	}

	/** What the side request sends: seed + recorded notes replayed inline. */
	messagesFor(threadId: string): AgentMessage[] {
		const thread = this.threads.get(threadId);
		if (thread === undefined) return [];
		const messages: AgentMessage[] = [...(this.seeds.get(threadId) ?? [])];
		for (const ex of thread.exchanges) {
			messages.push(sideUser(ex.question, ex.at));
			if (ex.answer.length > 0) messages.push(sideAssistant(ex.answer, ex.at + 1));
		}
		return messages;
	}

	/**
	 * Ask the thread and let it carry the wait: `pending` while the side request
	 * runs, an answered exchange when it lands, `error` when it does not. Nothing
	 * here takes the lane, so the question can be answered while a loop or a goal
	 * has the run.
	 */
	async ask(threadId: string, question: string): Promise<void> {
		const thread = this.threads.get(threadId);
		if (thread === undefined) return;
		const sideAsk = this.sideAsk;
		if (sideAsk === undefined) {
			this.fail(threadId, "no side model configured for this session");
			return;
		}
		this.begin(threadId, question);
		try {
			const answer = await sideAsk({
				threadId,
				kind: thread.kind,
				question,
				messages: this.messagesFor(threadId),
			});
			// The thread can be cleared while its request is in flight.
			if (!this.threads.has(threadId)) return;
			this.answer(threadId, question, answer.text, answer.steps.length === 0 ? undefined : answer.steps);
		} catch (error) {
			if (this.threads.has(threadId))
				this.fail(threadId, error instanceof Error ? error.message : String(error));
		}
	}

	/** Record a question as in flight; `answer`/`fail` settle it. */
	begin(threadId: string, question: string): void {
		const thread = this.threads.get(threadId);
		if (thread === undefined) return;
		thread.pending = { question, at: Date.now() };
		thread.error = undefined;
		this.observe?.("btw", "asking", { threadId });
	}

	/**
	 * Record a note. An entry can be a bare note (`answer` empty), a question with
	 * what turned out to be the answer, or an answered side request — which also
	 * carries the tools it ran, so an answer can be read against what it looked up.
	 */
	answer(threadId: string, question: string, answer = "", steps?: BtwToolStep[]): void {
		const thread = this.threads.get(threadId);
		if (thread === undefined) return;
		thread.pending = undefined;
		thread.error = undefined;
		thread.exchanges.push({ question, answer, at: Date.now(), ...(steps === undefined ? {} : { steps }) });
		this.observe?.("btw", "injected", { threadId });
	}

	/** A failed request leaves no exchange behind — a fake answer would replay as truth. */
	fail(threadId: string, message: string): void {
		const thread = this.threads.get(threadId);
		if (thread === undefined) return;
		thread.pending = undefined;
		thread.error = message;
		this.observe?.("btw", "failed", { threadId, message });
	}

	/**
	 * Save the thread's notes as a visible note in the main session.
	 * While the main run is busy the note queues and flushes at run end.
	 */
	save(threadId: string, running: boolean): BtwSaveState {
		const thread = this.threads.get(threadId);
		if (thread === undefined) return "not-saved";
		if (running) {
			thread.saveState = "queued";
			return thread.saveState;
		}
		void this.flushNote(thread);
		return thread.saveState;
	}

	/** Called at run boundaries: writes notes queued while the run was busy. */
	async flushQueued(): Promise<number> {
		let flushed = 0;
		for (const thread of this.threads.values()) {
			if (thread.saveState === "queued") {
				await this.flushNote(thread);
				flushed += 1;
			}
		}
		return flushed;
	}

	private async flushNote(thread: BtwThread): Promise<void> {
		for (const note of thread.exchanges) {
			await this.onVisibleNote?.(
				note.answer.length === 0
					? `btw ${thread.id}: ${note.question}`
					: `btw ${thread.id}: ${note.question} -> ${note.answer}`,
			);
		}
		thread.saveState = "saved";
		this.observe?.("btw", "saved", { threadId: thread.id });
	}

	/** Drop a thread from the panel; history written to the log stays. */
	clear(threadId: string): boolean {
		const had = this.threads.delete(threadId);
		if (had) this.observe?.("btw", "cleared", { threadId });
		return had;
	}

	/** FollowUp text handed to the main run (handoff = S1 driver), carrying the thread. */
	handoff(threadId: string): string | undefined {
		const thread = this.threads.get(threadId);
		if (thread === undefined || thread.exchanges.length === 0) return undefined;
		this.observe?.("btw", "summarized", { threadId });
		return handoffText(thread.id, thread.exchanges);
	}

	/** Re-register threads from a replayed `eta.btw` entry log. */
	replay(entries: { type: string; payload: unknown }[]): void {
		for (const entry of entries) {
			if (entry.type !== "btw") continue;
			const payload = entry.payload as BtwPayload & Partial<BtwThread>;
			if (typeof payload?.note !== "string") continue;
			const id = payload.id ?? `btw-replay-${++this.sequence}`;
			if (this.threads.has(id)) continue;
			this.threads.set(id, {
				id,
				kind: payload.kind ?? "tangent",
				exchanges: payload.exchanges ?? [],
				saveState: payload.saveState ?? "saved",
			});
		}
	}
}
