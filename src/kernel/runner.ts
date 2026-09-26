/**
 * Runner — the pure turn loop (REFACTOR.md §2.4).
 *
 * In-memory transcript → read the ToolService fresh → ask the providers seam
 * → execute tool calls through the middleware chain → feed results back →
 * run boundary when there are no tool calls. Every step is observable on the
 * bus (turn:*, tool:*); nothing here touches disk, network, or prompts policy.
 *
 * The durable-operation state machine is gone: crash semantics are "replay
 * the journal to the last stable boundary and rerun the current turn".
 */
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	Tool as PiTool,
	SimpleStreamOptions,
	ToolCall,
} from "@earendil-works/pi-ai";
import { isContextOverflow, isRecoverableLength, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { SessionLog } from "../session/session-log.ts";
import type { UsageRow } from "../storage/types.ts";
import type { CompactionEntry, Entry } from "../types/entries.ts";
import type { Emit } from "../types/events.ts";
import { kernelEmit, kernelOn } from "../types/events.ts";
import type { JsonValue } from "../types/json.ts";
import type { AgentMessage, ThinkingLevel, Usage } from "../types/messages.ts";
import { consumeAssistantStream } from "./assistant.ts";
import {
	type CompactionOutcome,
	type CompactionService,
	estimateContextTokens,
	fitCompactionSettings,
	shouldCompact,
} from "./compaction.ts";
import type { ConfigService } from "./config.ts";
import { AbortRequested, createGate, type Gate, type GateControl } from "./effect-gate.ts";
import type { GoalService } from "./goal.ts";
import type { QueuedItem } from "./inbox.ts";
import type { Kernel } from "./kernel.ts";
import { OutputRate } from "./output-rate.ts";
import type { PersonaService } from "./persona.ts";
import type { KernelModels } from "./providers.ts";
import { type AgentRetryPolicy, normalizedRetryPolicy, retryDelayMs, retryNotBefore, waitUntil } from "./retry.ts";
import type { KernelTool, ToolService } from "./tools.ts";
import { isAbortError } from "./tools.ts";

export interface RunnerBoundaryOptions {
	/** Independent judgment call for goal continuation (tool-free request); true = achieved. */
	evaluate: (objective: string, messages: readonly AgentMessage[]) => Promise<boolean>;
	/** Model-visible nudge texts are policy: the prompts plugin supplies them. */
	nudgeEmpty: () => AgentMessage;
	nudgeGoal: () => AgentMessage;
	/** Budget for re-nudging a well-formed-but-empty stop. Default 2. */
	emptyBudget?: number;
}

export interface RunnerOptions {
	/** The model layer: resolve the configured model, then generate. */
	models: KernelModels;
	/**
	 * The system prompt: a string, or a resolver that reads the tool context
	 * (eta-agent's `Config.systemPrompt`). The prompts plugin contributes through
	 * the resolver form; the kernel ships no prompt text of its own.
	 */
	systemPrompt?: string | ((toolContext: unknown) => string | Promise<string>);
	/**
	 * What tools see about their environment: a value, or a resolver read at
	 * request time (eta-agent's `Config.toolContext`).
	 */
	toolContext?: unknown | (() => unknown | Promise<unknown>);
	/**
	 * Project plugin-added entry kinds into messages when replaying a journal
	 * (eta-agent's `entryProjectors`). The kernel's own kinds are built in; this
	 * is how an extension teaches the transcript about its own entries.
	 */
	entryProjectors?: Record<string, (entry: Entry) => AgentMessage | undefined>;
	/**
	 * Compaction, when a plugin provides one. The runner only calls it: at a run
	 * boundary when the history no longer fits, and after a context overflow.
	 */
	compaction?: CompactionService;
	/**
	 * Project the transcript into provider messages. Required once the context
	 * holds a message the provider has no vocabulary for — a compaction or branch
	 * summary. The kernel does not invent that text: the prompts plugin owns it
	 * (§3 ruling 5), and a missing projection fails loudly instead of quietly
	 * sending the model a context with the summary stripped out.
	 */
	toProviderMessages?: (messages: readonly AgentMessage[]) => Message[];
	/** Run-boundary decisions (REFACTOR.md §2.4 step 5); without it the boundary is a plain stop. */
	boundary?: RunnerBoundaryOptions;
	/**
	 * History restored from a journal. It goes into the transcript without being
	 * journaled again — the journal is where it came from.
	 */
	initialTranscript?: readonly AgentMessage[];
	/**
	 * Optional journal: the runner records what it appends and commits once per
	 * turn, so the journal holds complete turns and nothing else (§K5).
	 */
	journal?: SessionLog;
	/**
	 * When true, an inject arriving while the runner is idle immediately starts
	 * a new run (REFACTOR.md §2.5). The server turns this on for live sessions;
	 * one-shot callers (subagents) leave it off.
	 */
	autoPump?: boolean;
}

/** What a request would carry right now (eta-agent's LaneRequestState). */
export interface RequestState {
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel;
	tools: PiTool[];
	/** Selected tool names with nothing registered under them. */
	missingToolNames: string[];
	systemPrompt: string;
	streamOptions?: SimpleStreamOptions | undefined;
	retryPolicy?: AgentRetryPolicy | undefined;
	toolContext: unknown;
}

export interface RunResult {
	turns: number;
	/**
	 * How the run ended: a clean stop, a failure, or the caller cancelling it.
	 * An abort is not a failure — the work simply stopped where it was.
	 */
	status: "completed" | "failed" | "aborted";
	/** Set when the run ended on a provider error rather than a clean stop. */
	error?: string;
}

const charsToTokens = (text: string): number => Math.ceil(text.length / 4);

export class Runner {
	private readonly kernel: Kernel;
	private readonly tools: ToolService;
	private readonly goal: GoalService;
	private readonly persona: PersonaService;
	private readonly options: RunnerOptions;
	private readonly config: ConfigService;
	private readonly models: KernelModels;
	private readonly journal: SessionLog | undefined;
	private readonly emit: Emit;
	private readonly transcript: AgentMessage[] = [];
	private emptyStops = 0;
	private pumping = false;
	private currentRunId: string | undefined;
	private currentTurnId: string | undefined;
	private turnToolResults: AgentMessage[] = [];
	private inFlight: Promise<RunResult> | undefined;
	private readonly rate = new OutputRate();
	private gate: { gate: Gate; control: GateControl } | undefined;
	private readonly pendingEffects = new Set<Promise<unknown>>();
	/** One overflow recovery per run: a second overflow is a real failure. */
	private overflowRecoveryUsed = false;
	private autoPumpOff: (() => boolean) | undefined;

	constructor(kernel: Kernel, options: RunnerOptions) {
		this.kernel = kernel;
		this.options = options;
		this.emit = kernelEmit(kernel.ctx);
		this.journal = options.journal;
		this.config = kernel.config;
		this.models = options.models;
		if (options.initialTranscript !== undefined) this.transcript.push(...options.initialTranscript);
		this.tools = kernel.tools;
		this.goal = kernel.goal;
		this.persona = kernel.persona;
		if (options.autoPump) {
			this.autoPumpOff = kernelOnAuto(kernel.ctx, () => {
				if (!this.pumping && this.kernel.inboxDepth > 0) {
					void this.run();
				}
			});
		}
	}

	/**
	 * Abort the run in flight: generation streams stop, a retry backoff gives up,
	 * and the run ends as aborted rather than failed (REFACTOR.md §2.4). Tool
	 * execution joins this signal in the tool-execution step.
	 */
	abort(): void {
		const gate = this.gate;
		if (gate === undefined) return;
		// Stop admitting new effects first, then abort the signal the running ones
		// observe; `cancellation()` is what the caller's AbortRequested carries.
		gate.control.beginAbort(this.cancellation());
		gate.control.signalAbort();
	}

	/** Resolves when every effect that already started has settled. */
	private cancellation(): Promise<void> {
		return Promise.allSettled([...this.pendingEffects]).then(() => undefined);
	}

	/** Track an effect so an abort can wait for it. */
	private track<T>(work: Promise<T>): Promise<T> {
		this.pendingEffects.add(work);
		void work.finally(() => this.pendingEffects.delete(work)).catch(() => undefined);
		return work;
	}

	/** The signal the current run passes to generation, tools, and its backoffs. */
	private runSignal(): AbortSignal {
		return this.gate?.gate.signal ?? new AbortController().signal;
	}

	/**
	 * The messages the runner would send right now (§3 ruling 4). Handed to
	 * compaction so it can estimate and cut; a copy, so a reader cannot edit the
	 * transcript by accident.
	 */
	readContext(): AgentMessage[] {
		return this.transcript.slice();
	}

	/**
	 * Replace the context with a summary plus whatever tail is kept. The
	 * compaction entry goes into the journal, so a replay rebuilds the same
	 * transcript (SessionLog projects it the same way).
	 */
	replaceContext(
		summary: string,
		options: { retainedTail?: readonly AgentMessage[]; tokensBefore?: number; usage?: Usage } = {},
	): CompactionEntry | undefined {
		const retainedTail = [...(options.retainedTail ?? [])];
		const tokensBefore = options.tokensBefore ?? estimateContextTokens(this.transcript).tokens;
		this.transcript.length = 0;
		this.transcript.push({
			role: "compactionSummary",
			summary,
			tokensBefore,
			timestamp: Date.now(),
		});
		this.transcript.push(...retainedTail);
		return this.journal?.record<CompactionEntry>({
			id: `compaction-${Date.now().toString(36)}`,
			parentId: null,
			type: "compaction",
			summary,
			retainedTail,
			tokensBefore,
			...(options.usage === undefined ? {} : { usage: options.usage }),
		});
	}

	/**
	 * Record a usage measurement outside generation (eta-agent's
	 * `lane.recordUsage`): a correction, or what a side request cost. It is an
	 * adjustment, and it lands in the journal with the totals after it.
	 */
	async recordUsage(
		usage: Usage,
		options: { entryId?: string; details?: JsonValue } = {},
	): Promise<UsageRow | undefined> {
		const journal = this.journal;
		if (journal === undefined) return undefined;
		journal.recordUsage({
			id: usageId(),
			usage,
			adjustment: true,
			...(options.entryId === undefined ? {} : { entryId: options.entryId }),
			...(options.details === undefined ? {} : { details: options.details }),
		});
		const committed = await journal.commit();
		const row = committed?.usage[0];
		if (row !== undefined) this.emit("usage:recorded", { row, totals: committed!.result.stats.usage });
		return row;
	}

	/** Output tokens/sec for the run in progress (see OutputRate for the scale). */
	get tokensPerSec(): number {
		return this.rate.value;
	}

	/** Stop listening for idle injects (runner teardown). */
	stopAutoPump(): void {
		this.autoPumpOff?.();
		this.autoPumpOff = undefined;
	}

	/** The messages the runner would send to the provider right now. */
	getTranscript(): readonly AgentMessage[] {
		return this.transcript;
	}

	/**
	 * What a request would look like right now (eta-agent's LaneRequestState):
	 * model, thinking level, tools, prompt, stream options, retry policy, all
	 * read live. A side request — a btw thread, a subagent — builds from this
	 * instead of capturing the run's configuration, so it follows whatever the
	 * user has chosen since.
	 */
	async requestState(): Promise<RequestState> {
		const config = this.config.get();
		const toolContext = await this.resolveToolContext();
		const { tools, missing } = this.activeTools();
		return {
			model: this.models.getModel(config.model.provider, config.model.modelId),
			thinkingLevel: config.thinkingLevel,
			tools: tools.map((tool) => ({
				name: tool.name,
				description: tool.description ?? "",
				parameters:
					(tool as unknown as { parameters?: PiTool["parameters"] }).parameters ?? ({} as PiTool["parameters"]),
			})),
			missingToolNames: missing,
			systemPrompt: await this.resolveSystemPrompt(toolContext),
			streamOptions: config.streamOptions,
			retryPolicy: config.retryPolicy,
			toolContext,
		};
	}

	/** Resolve the tool context: a value, or a resolver read now. */
	private async resolveToolContext(): Promise<unknown> {
		const source = this.options.toolContext;
		return typeof source === "function" ? await (source as () => unknown | Promise<unknown>)() : source;
	}

	/** Resolve the system prompt: a string, or a resolver given the tool context. */
	private async resolveSystemPrompt(toolContext: unknown): Promise<string> {
		const source = this.options.systemPrompt;
		if (source === undefined) return "";
		return typeof source === "string" ? source : await source(toolContext);
	}

	/**
	 * The tools this request offers: the configured selection when there is one,
	 * otherwise everything registered. A selected name with no tool is reported,
	 * not silently dropped (eta-agent fails the run on it).
	 */
	private activeTools(): { tools: KernelTool[]; missing: string[] } {
		const active = this.config.read("activeToolNames");
		if (active.length === 0) return { tools: this.tools.list(), missing: [] };
		const registered = new Map(this.tools.list().map((tool) => [tool.name, tool]));
		const tools: KernelTool[] = [];
		const missing: string[] = [];
		for (const name of active) {
			const tool = registered.get(name);
			if (tool === undefined) missing.push(name);
			else tools.push(tool);
		}
		return { tools, missing };
	}

	/**
	 * One run: turns until no tool calls, budget spent, or a provider error.
	 * Injected messages are drained at every boundary.
	 */
	async run(): Promise<RunResult> {
		// Concurrent run() calls (autoPump racing a host call) share one loop.
		if (this.inFlight !== undefined) return this.inFlight;
		this.inFlight = this.runLoop();
		try {
			return await this.inFlight;
		} finally {
			this.inFlight = undefined;
		}
	}

	private async runLoop(): Promise<RunResult> {
		let error: string | undefined;
		let status: RunResult["status"] = "completed";
		this.pumping = true;
		const runId = crypto.randomUUID();
		const { gate, control } = createGate();
		this.gate = { gate, control };
		this.overflowRecoveryUsed = false;
		// A new run starts the throughput window over: nothing has been produced yet.
		this.rate.reset();
		this.emit("turn:run-start", { runId, startedAt: Date.now() });
		// What a run takes when it starts: next-run items always, steering and
		// follow-ups per their modes. They become the run's opening transcript.
		this.adopt(this.kernel.acceptInbox());
		try {
			for (;;) {
				// Each step is an effect: a cancelled run does not start another one.
				// The gate throws AbortRequested here, which unwinds to the catch.
				gate.admit(() => undefined);
				// The model is resolved live: a run started on one model and switched
				// mid-flight must send the next request to the new one (§2.4).
				const identity = this.config.read("model");
				const model = this.models.getModel(identity.provider, identity.modelId);
				if (model === undefined) {
					error = `model_unavailable: ${identity.provider}/${identity.modelId}`;
					break;
				}
				// A selected tool with no implementation is a configuration failure,
				// not a silent omission: the run would otherwise answer with a toolset
				// the user did not choose (eta-agent's configured_tools_unavailable).
				const { missing } = this.activeTools();
				if (missing.length > 0) {
					error = `configured_tools_unavailable: ${missing.join(", ")}`;
					break;
				}
				const turn = this.kernel.turns + 1;
				this.currentRunId = runId;
				this.currentTurnId = crypto.randomUUID();
				this.turnToolResults = [];
				if (turn === 1) await this.compactForWindow(model, runId);
				const assistant = await this.takeTurn(model);
				if (assistant === undefined) break;
				if (assistant.stopReason === "error") {
					error = assistant.errorMessage ?? "provider error";
					break;
				}
				const toolCalls = assistant.content.filter((c): c is ToolCall => c.type === "toolCall");
				if (toolCalls.length === 0) {
					// A steer that arrived while this turn was being generated still gets
					// the next request, not the following one.
					const { steers: lateSteers } = this.kernel.takeAtBoundary({ followUpWhenNoTrigger: false });
					if (lateSteers.length > 0) {
						this.adopt(lateSteers);
						continue;
					}
					// Run boundary: de-hooked (REFACTOR.md §2.4 step 5) — the runner asks
					// the goal directly instead of waiting for a followUp hook slot.
					if (!(await this.atRunBoundary(assistant))) {
						// Nothing else continues the run: a follow-up gets its chance.
						const { followUps } = this.kernel.takeAtBoundary({ followUpWhenNoTrigger: true });
						if (followUps.length > 0) {
							this.adopt(followUps);
							continue;
						}
						// A steer may have arrived while the boundary was deciding (or
						// during the evaluator's async call): it opens a new turn instead
						// of ending the run underneath it. A next-run item does not: it is
						// for the run after this one.
						if (this.kernel.inbox.list().some((item) => item.kind === "steer")) continue;
						break;
					}
				} else {
					await this.executeToolBatch(toolCalls, turn);
					// The checkpoint after a tool batch: steering lands here, so the very
					// next request carries it. Follow-ups wait for a boundary that could
					// end the run.
					const { steers: afterTools } = this.kernel.takeAtBoundary({ followUpWhenNoTrigger: false });
					if (afterTools.length > 0) this.adopt(afterTools);
				}
				if (!this.kernel.noteTurn()) break;
				// The turn had tool work: keep looping. A message injected mid-run
				// (tool or middleware) never interrupts; it opens the next turn via
				// the drain at the top of the loop.
				await this.journal?.commit();
			}
		} catch (caught) {
			// Cancellation is expected control flow, not a failure: it unwinds the
			// loop, waits for the effects that already started, and reports aborted.
			if (caught instanceof AbortRequested || isAbortError(caught)) {
				status = "aborted";
				await (caught instanceof AbortRequested ? caught.cancellation : this.cancellation());
			} else {
				throw caught;
			}
		}
		this.pumping = false;
		if (error !== undefined) status = "failed";
		// Whatever is left staged (the final turn) lands as one commit, so the
		// journal holds complete turns and nothing else.
		await this.journal?.commit();
		const result: RunResult = { turns: this.kernel.turns, status, ...(error === undefined ? {} : { error }) };
		this.emit("turn:run-end", {
			runId,
			turns: result.turns,
			endedAt: Date.now(),
			status,
			...(error === undefined ? {} : { error }),
		});
		if (this.options.autoPump && this.kernel.inboxDepth > 0 && error === undefined) {
			// An inject raced with the run-end above; pump it immediately.
			return this.run();
		}
		return result;
	}

	/**
	 * Compact before the first request when the history no longer fits the model
	 * that owns it (eta-agent's `compactForWindow`). A session written under a
	 * bigger model would otherwise be sent whole to a smaller one.
	 */
	private async compactForWindow(model: Model<Api>, runId: string): Promise<void> {
		await this.runCompaction("threshold", model, runId);
	}

	/** Ask the compaction service to cut, then adopt what it produced. */
	private async runCompaction(
		reason: "threshold" | "overflow" | "manual",
		model: Model<Api>,
		runId: string,
	): Promise<boolean> {
		const compaction = this.options.compaction;
		if (compaction === undefined) return false;
		const config = this.config.get();
		const settings = fitCompactionSettings(config.compaction, model);
		const estimate = estimateContextTokens(this.transcript);
		if (reason !== "overflow" && !shouldCompact(estimate.tokens, model.contextWindow, settings)) return false;

		this.emit("compaction:start", { runId, reason, startedAt: Date.now() });
		let outcome: CompactionOutcome | undefined;
		try {
			outcome = await compaction.compact({
				reason,
				messages: this.readContext(),
				entries: this.journal?.graph.pathOldestFirst() ?? [],
				settings,
				contextWindow: model.contextWindow,
				estimatedTokens: estimate.tokens,
				model,
				thinkingLevel: config.thinkingLevel,
				streamOptions: config.streamOptions,
				signal: this.runSignal(),
				summarize: async (prompt) => {
					const stream = await this.models.completeSimple(
						model,
						{
							...(prompt.systemPrompt === undefined ? {} : { systemPrompt: prompt.systemPrompt }),
							messages: prompt.messages.filter(isMessage),
						},
						{ signal: this.runSignal() },
					);
					return stream;
				},
			});
		} catch (error) {
			this.emit("compaction:end", {
				runId,
				reason,
				endedAt: Date.now(),
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
		if (outcome === undefined) {
			this.emit("compaction:end", { runId, reason, endedAt: Date.now(), status: "declined" });
			return false;
		}
		const entry = this.replaceContext(outcome.summary, {
			retainedTail: outcome.retainedTail,
			tokensBefore: outcome.tokensBefore,
			usage: outcome.usage,
		});
		this.emit("compaction:end", {
			runId,
			reason,
			endedAt: Date.now(),
			status: "completed",
			...(entry === undefined ? {} : { entryId: entry.id }),
		});
		return true;
	}

	/** True when the run should continue (a nudge went into the transcript). */
	private async atRunBoundary(assistant: AssistantMessage): Promise<boolean> {
		const boundary = this.options.boundary;
		if (boundary === undefined) return false;

		// Empty-response guard: a clean stop with nothing in it gets nudged back.
		const emptyBudget = boundary.emptyBudget ?? 2;
		if (isEmptyStop(assistant)) {
			if (this.emptyStops < emptyBudget) {
				this.emptyStops += 1;
				this.push(boundary.nudgeEmpty());
				return true;
			}
			this.emptyStops = 0;
		} else {
			this.emptyStops = 0;
		}

		// Goal continuation: anti-spin first, then the evaluator, then a nudge.
		this.goal.recordTurnOutcome(this.currentRunUsedTools());
		if (!this.goal.wantsContinuation()) {
			const state = this.goal.current;
			if (state !== undefined && state.status === "active" && state.roundCount >= this.goal.maxContinuations) {
				this.goal.pause("max-continuations");
			}
			return false;
		}
		const objective = this.goal.current?.objective;
		if (objective === undefined) return false;
		if (await boundary.evaluate(objective, this.transcript)) {
			this.goal.markAchieved();
			return false;
		}
		this.goal.noteContinuation();
		this.push(boundary.nudgeGoal());
		return true;
	}

	/** Whether the run since the last user message involved any tool work. */
	private currentRunUsedTools(): boolean {
		const messages = this.transcript;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") return runUsedTools(messages.slice(i));
		}
		return runUsedTools(messages);
	}

	/** Add a message to the transcript and the journal, in step. */
	private push(message: AgentMessage): void {
		this.transcript.push(message);
		this.journal?.recordMessage(message);
	}

	/** Adopt accepted inbox items into the transcript and the journal. */
	private adopt(items: readonly QueuedItem[]): void {
		for (const item of items) {
			this.transcript.push(item.message);
			this.journal?.recordMessage(item.message);
		}
		if (items.length > 0) this.emit("queue:update", { queues: this.kernel.inbox.list() });
	}

	private async takeTurn(model: Model<Api>): Promise<AssistantMessage | undefined> {
		const runId = this.currentRunId ?? "";
		const turnId = this.currentTurnId ?? "";
		const toolContext = await this.resolveToolContext();
		const systemPrompt = await this.resolveSystemPrompt(toolContext);
		this.emit("turn:start", {
			runId,
			turnId,
			contextParts: this.estimateParts(this.assembleContext(toolContext, systemPrompt)),
		});
		const config = this.config.get();
		const policy = normalizedRetryPolicy(config.retryPolicy);
		const signal = this.runSignal();
		const intendedOutputLimit = model.maxTokens ?? 0;
		let attempt = 1;
		let assistant: AssistantMessage;
		for (;;) {
			// Assembled per attempt: a compaction between attempts replaces the
			// context the next request must carry.
			const context = this.assembleContext(toolContext, systemPrompt);
			this.emit("prompt:assembled", {
				runId,
				systemPromptChars: (context.systemPrompt ?? "").length,
				messages: context.messages.length,
				attempt,
			});
			assistant = await consumeAssistantStream(
				this.models.streamSimple(model, context, {
					...config.streamOptions,
					signal,
					// "off" is the kernel's spelling for "no reasoning field at all".
					...(config.thinkingLevel === "off" ? {} : { reasoning: config.thinkingLevel }),
				}),
				{
					start: () => {
						this.emit("message:start", { runId, turnId });
					},
					update: (message, event) => {
						// Every frame is a snapshot: nothing downstream may hold a live
						// reference into the provider's in-flight message.
						this.emit("message:update", {
							runId,
							turnId,
							message: structuredClone(message),
							event: structuredClone(event),
						});
						this.rate.inFlight(message.usage.output);
					},
					end: () => undefined,
				},
			);

			if (assistant.stopReason !== "error" && assistant.stopReason !== "length") {
				if (attempt > 1) this.emit("retry:end", { runId, step: turnId, attempt, success: true });
				break;
			}
			// Context overflow is recovered by cutting the history once, not by
			// waiting: the same request cannot fit until the context shrinks.
			const overflow =
				isContextOverflow(assistant, model.contextWindow) || isRecoverableLength(assistant, intendedOutputLimit);
			if (overflow && !this.overflowRecoveryUsed) {
				this.overflowRecoveryUsed = true;
				if (await this.runCompaction("overflow", model, runId)) continue;
				break;
			}
			if (assistant.stopReason !== "error") break;
			// A failed attempt is never journaled: it is not history, and it must
			// not enter the context the next attempt sends. Retryable transport
			// failures get another attempt; deterministic ones end the run.
			const retryable = isRetryableAssistantError(assistant);
			if (!retryable || attempt >= policy.maxAttempts) {
				if (attempt > 1) {
					this.emit("retry:end", {
						runId,
						step: turnId,
						attempt,
						success: false,
						finalError: assistant.errorMessage ?? `Assistant request ended with ${assistant.stopReason}`,
					});
				}
				break;
			}
			const notBefore = retryNotBefore(policy, attempt);
			this.emit("retry:scheduled", {
				runId,
				step: turnId,
				attempt: attempt + 1,
				maxAttempts: policy.maxAttempts,
				delayMs: retryDelayMs(policy, attempt),
				notBefore,
				errorMessage: assistant.errorMessage ?? "Assistant request failed",
			});
			await waitUntil(notBefore, signal);
			attempt += 1;
			this.emit("retry:start", { runId, step: turnId, attempt });
		}
		// The provider's own count is what the rate commits; the streaming estimate
		// only ever stands in until the message settles.
		this.rate.commit(assistant.usage.output);
		// A failed generation is not history: eta-agent records no entry for it, and
		// a failed message in the transcript would be sent back to the model.
		if (assistant.stopReason !== "error" && assistant.stopReason !== "aborted") {
			this.transcript.push(assistant);
			const entry = this.journal?.recordMessage(assistant);
			if (entry !== undefined) {
				this.emit("message:end", { runId, message: assistant, entryId: entry.id });
				// The usage rides in the same commit as the entry it was spent on, so
				// a replayed journal rebuilds the same totals.
				this.journal?.recordUsage({
					id: usageId(),
					usage: assistant.usage,
					entryId: entry.id,
					adjustment: false,
				});
			}
			// The assistant's intent is durable before its tools have side effects.
			const committed = await this.journal?.commit();
			for (const row of committed?.usage ?? []) {
				this.emit("usage:recorded", { row, totals: committed!.result.stats.usage });
			}
		}
		this.emit("turn:end", {
			runId,
			turnId,
			message: assistant,
			toolResults: this.turnToolResults,
			usage: assistant.usage,
		});
		return assistant;
	}

	/**
	 * Run a turn's tool calls and record the results in call order. Sequential or
	 * parallel comes from the live config (eta-agent's run.settings.toolExecution);
	 * a failure in one call does not cancel its siblings — every call has to
	 * produce a result, or the model is left with a call it never heard back on.
	 */
	private async executeToolBatch(calls: readonly ToolCall[], turn: number): Promise<void> {
		const execution = this.config.read("toolExecution");
		const runId = this.currentRunId ?? "";
		const turnId = this.currentTurnId ?? "";
		for (const call of calls) {
			this.emit("tool:start", { runId, turnId, toolCallId: call.id, toolName: call.name, args: call.arguments });
		}
		const started = new Map<string, number>();
		for (const call of calls) started.set(call.id, Date.now());
		const gate = this.gate?.gate;
		const signal = this.runSignal();
		const outcomes = await this.tools.executeBatch(
			calls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
			{
				execution,
				turn,
				signal,
				toolContext: await this.resolveToolContext(),
				// Every tool call is an effect: once the run is aborting, no new one
				// is admitted, and the call reports the cancellation instead of running.
				admit: gate === undefined ? <T>(work: () => T) => work() : <T>(work: () => T) => gate.admit(work),
				track: <T>(work: Promise<T>) => this.track(work),
			},
		);
		for (const outcome of outcomes) {
			const call = calls.find((candidate) => candidate.id === outcome.id)!;
			await this.recordToolResult(call, outcome.result, turn, started.get(outcome.id) ?? Date.now());
		}
	}

	/** Emit the result event and put the tool result into the transcript. */
	private async recordToolResult(call: ToolCall, raw: unknown, turn: number, startedAt: number): Promise<void> {
		const runId = this.currentRunId ?? "";
		const turnId = this.currentTurnId ?? "";
		const durationMs = Date.now() - startedAt;
		const isError = typeof raw === "object" && raw !== null && "isError" in raw && raw.isError === true;
		this.emit("tool:end", {
			runId,
			turnId,
			toolCallId: call.id,
			toolName: call.name,
			result: raw,
			isError,
			terminate: false,
			durationMs,
		});
		const text = typeof raw === "string" ? raw : JSON.stringify(raw);
		const result = {
			role: "toolResult" as const,
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text" as const, text }],
			isError,
			timestamp: Date.now(),
		} as AgentMessage;
		this.transcript.push(result);
		this.turnToolResults.push(result);
		const entry = this.journal?.recordMessage(result);
		if (entry !== undefined) this.emit("message:end", { runId, message: result, entryId: entry.id });
	}

	private assembleContext(toolContext: unknown, systemPrompt: string): Context {
		const personaBlock = this.persona.renderActive().text;
		const prompt = [systemPrompt, personaBlock].filter((part) => part.length > 0).join("\n\n");
		const tools: PiTool[] = this.activeTools().tools.map((tool) => ({
			name: tool.name,
			description: tool.description ?? "",
			parameters:
				(tool as unknown as { parameters?: PiTool["parameters"] }).parameters ?? ({} as PiTool["parameters"]),
		}));
		void toolContext;
		return {
			...(prompt.length > 0 ? { systemPrompt: prompt } : {}),
			messages: this.projectMessages(this.transcript),
			tools,
		};
	}

	/** Transcript → provider messages, with the custom-message case made explicit. */
	private projectMessages(messages: readonly AgentMessage[]): Message[] {
		const hook = this.options.toProviderMessages;
		if (hook !== undefined) return hook(messages);
		const custom = messages.find(
			(message) => message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult",
		);
		if (custom !== undefined) {
			throw new Error(
				`toProviderMessages is required: the context holds a ${custom.role} message (a compaction or branch summary) and the kernel does not invent prompt text`,
			);
		}
		return messages.filter(isMessage);
	}

	private estimateParts(context: Context): import("../types/events.ts").ContextPartStats {
		const system = charsToTokens(context.systemPrompt ?? "");
		let user = 0;
		let assistant = 0;
		for (const m of context.messages) {
			const text = JSON.stringify(m.content);
			if (m.role === "user") user += charsToTokens(text);
			else assistant += charsToTokens(text);
		}
		const toolDefs = charsToTokens(JSON.stringify(context.tools ?? []));
		// Persona is currently folded into systemPrompt; the prompts seam will
		// report it as its own part later.
		return { system, persona: 0, user, assistant, toolDefs, total: system + user + assistant + toolDefs };
	}
}

/** True when an assistant message stopped cleanly with nothing in it. */
export function isEmptyStop(message: AgentMessage): boolean {
	const m = message as { role?: string; stopReason?: string; content?: unknown };
	if (m.role !== "assistant" || m.stopReason !== "stop") return false;
	if (!Array.isArray(m.content) || m.content.length === 0) return true;
	return m.content.every((p) => {
		const part = p as { type?: string; text?: string };
		return part.type === "text" && (part.text ?? "").trim() === "";
	});
}

function runUsedTools(messages: readonly AgentMessage[]): boolean {
	for (const m of messages) {
		if (m.role === "toolResult") return true;
		if (m.role === "assistant" && m.content.some((p) => p.type === "toolCall")) return true;
	}
	return false;
}

let usageCounter = 0;

/** A usage row id, unique within a session journal. */
function usageId(): string {
	usageCounter += 1;
	return `usage-${usageCounter.toString(36)}-${Date.now().toString(36)}`;
}

function kernelOnAuto(ctx: Parameters<typeof kernelOn>[0], onInject: () => void): () => boolean {
	return kernelOn(ctx)("inject:received", onInject);
}

function isMessage(m: AgentMessage): m is Message {
	return m.role === "user" || m.role === "assistant" || m.role === "toolResult";
}
