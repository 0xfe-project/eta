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
import type { Entry } from "../types/entries";
import type { Emit } from "../types/events";
import { kernelEmit } from "../types/events";
import type { AgentMessage, ThinkingLevel } from "../types/messages";
import type { CompactionDriver } from "./compaction";
import type { ConfigService } from "./config";
import { AbortRequested, createGate, type Gate, type GateControl } from "./effect-gate";
import { generateWithRetry } from "./generation";
import type { GoalService } from "./goal";
import type { QueuedItem } from "./inbox";
import type { Kernel } from "./kernel";
import type { KernelModels } from "./providers";
import type { AgentRetryPolicy } from "./retry";
import type { KernelTool, ToolService } from "./tools";

/**
 * What the runner needs from durability (REFACTOR.md §3 ruling 6): the run
 * boundary waits for the disk, so "the run finished" means "the run is durable".
 * Everything else about the journal — what is written, when, and in what order —
 * belongs to the journaling service, which the runner never sees.
 */
export interface RunnerJournal {
	/** Resolve once everything written so far is on disk. */
	flush(): Promise<void>;
}

import { isAbortError } from "./tools";

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
	 * Project the transcript into provider messages. Required once the context
	 * holds a message the provider has no vocabulary for — a compaction or branch
	 * summary. The kernel does not invent that text: the prompts plugin owns it
	 * (§3 ruling 5), and a missing projection fails loudly instead of quietly
	 * sending the model a context with the summary stripped out.
	 */
	toProviderMessages?: (messages: readonly AgentMessage[]) => Message[];
	/**
	 * The compaction driver this run may ask to shrink its history (REFACTOR.md
	 * §2.4). The runner knows the seam and nothing else: no arithmetic, no
	 * summary, no journal. Without a driver there is no compaction at all.
	 */
	compaction?: CompactionDriver;
	/** Run-boundary decisions (REFACTOR.md §2.4 step 5); without it the boundary is a plain stop. */
	boundary?: RunnerBoundaryOptions;
	/**
	 * The session's durability, for the one thing the runner does about it: wait
	 * at the run boundary. Without one, a run finishes in memory only (a subagent
	 * or a throwaway session).
	 */
	journal?: RunnerJournal;
	/**
	 * History restored from a journal. It goes into the transcript without being
	 * journaled again — the journal is where it came from.
	 */
	initialTranscript?: readonly AgentMessage[];
	/**
	 * Messages one request carries and the next one may not (eta-agent's
	 * `transform_context`): appended after the transcript, never added to it, never
	 * journalled. A reminder is the usual one — it belongs in the request it was due
	 * for, and the transcript should not remember that the model was nagged, nor
	 * should a compaction preserve the nag.
	 *
	 * Read once per turn, so a request that is not sent does not consume anything.
	 */
	transientMessages?: () => AgentMessage | readonly AgentMessage[] | undefined;
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
	private readonly options: RunnerOptions;
	private readonly config: ConfigService;
	private readonly models: KernelModels;
	private readonly emit: Emit;
	/** The compaction driver, when the host supplied one (the kernel owns none). */
	private compaction: CompactionDriver | undefined;
	/** Durability, for the one wait at the run boundary (the kernel owns no journal). */
	private readonly journal: RunnerJournal | undefined;
	private readonly transcript: AgentMessage[] = [];
	private emptyStops = 0;
	private currentRunId: string | undefined;
	private currentTurnId: string | undefined;
	private turnToolResults: AgentMessage[] = [];
	private inFlight: Promise<RunResult> | undefined;
	private gate: { gate: Gate; control: GateControl } | undefined;
	private readonly pendingEffects = new Set<Promise<unknown>>();

	constructor(kernel: Kernel, options: RunnerOptions) {
		this.kernel = kernel;
		this.options = options;
		this.emit = kernelEmit(kernel.ctx);
		this.config = kernel.config;
		this.models = options.models;
		this.journal = options.journal;
		if (options.initialTranscript !== undefined) this.transcript.push(...options.initialTranscript);
		this.tools = kernel.tools;
		this.goal = kernel.goal;
		this.attachCompaction(options.compaction);
	}

	/**
	 * Hand a compaction driver the context it may replace (REFACTOR.md §3 ruling
	 * 4). Called with the run's options, or by a host that builds the driver only
	 * once it holds the runner (a session assembler). Either way: before the
	 * first run, and the last driver wins.
	 */
	attachCompaction(driver: CompactionDriver | undefined): void {
		this.compaction = driver;
		if (driver === undefined) return;
		driver.attach({
			readContext: () => this.readContext(),
			replaceContext: (summary, options) => this.replaceContext(summary, options),
			request: () => {
				const config = this.config.get();
				const identity = config.model;
				return {
					model: this.models.getModel(identity.provider, identity.modelId),
					thinkingLevel: config.thinkingLevel,
					streamOptions: config.streamOptions,
					signal: this.runSignal(),
					runId: this.currentRunId ?? "",
					ask: (prompt, askOptions) =>
						this.models.completeSimple(
							this.models.getModel(identity.provider, identity.modelId)!,
							{
								...(prompt.systemPrompt === undefined ? {} : { systemPrompt: prompt.systemPrompt }),
								messages: prompt.messages.filter(isMessage),
							},
							{
								signal: this.runSignal(),
								// A summary request is not the conversation: it gets its own
								// token budget, and caching it would spend what it saves.
								cacheRetention: "none",
								...(askOptions?.maxTokens === undefined ? {} : { maxTokens: askOptions.maxTokens }),
								// "off" means no reasoning field at all, as everywhere else.
								...(askOptions?.reasoning === undefined || askOptions.reasoning === "off"
									? {}
									: { reasoning: askOptions.reasoning }),
							},
						),
				};
			},
		});
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
	replaceContext(summary: string, options: { retainedTail?: readonly AgentMessage[]; tokensBefore: number }): void {
		const retainedTail = [...(options.retainedTail ?? [])];
		// What the history cost is the summarizer's fact, not the runner's: the
		// runner counts no tokens (a fallback here would be arithmetic the kernel
		// does not own, and a wrong number in the entry when it guessed).
		const tokensBefore = options.tokensBefore;
		this.transcript.length = 0;
		this.transcript.push({
			role: "compactionSummary",
			summary,
			tokensBefore,
			timestamp: Date.now(),
		});
		this.transcript.push(...retainedTail);
	}

	/** Whether a run is in flight (an idle waker's guard, a dashboard's fact). */
	get running(): boolean {
		return this.inFlight !== undefined;
	}

	/** The messages the runner would send to the provider right now. */
	getTranscript(): readonly AgentMessage[] {
		return this.transcript;
	}

	/**
	 * Add history the runner did not generate itself (a restored log, a host's
	 * prepended context). It is part of the transcript and the journal, exactly
	 * like a message the loop pushed.
	 */
	adoptTranscript(messages: readonly AgentMessage[]): void {
		for (const message of messages) this.push(message);
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
		// Concurrent run() calls (a pumped run racing a host call) share one loop.
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
		const runId = crypto.randomUUID();
		const { gate, control } = createGate();
		this.gate = { gate, control };
		this.emit("turn:run-start", { runId, startedAt: Date.now() });
		// What a run takes when it starts: next-run items always, steering and
		// follow-ups per their modes. They become the run's opening transcript.
		this.adopt(this.kernel.acceptInbox());
		// Compaction's threshold check belongs to the first turn of every run, not
		// to the first turn this kernel ever ran: a session can grow past the
		// ceiling between two runs, and the second one must still notice.
		let firstTurnOfRun = true;
		try {
			for (;;) {
				// Each step is an effect: a cancelled run does not start another one.
				// The gate throws AbortRequested here, which unwinds to the catch.
				gate.admit(() => undefined);
				// The budget is checked before a turn is started, so `turns` is the
				// number of turns actually taken.
				if (this.kernel.budgetSpent) break;
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
				if (firstTurnOfRun) {
					firstTurnOfRun = false;
					// Compaction's threshold decision belongs to the service; the runner
					// only knows that a run is starting.
					await this.compaction?.threshold();
				}
				const assistant = await this.takeTurn(model);
				// Every turn the loop takes counts, including one that ends the run.
				this.kernel.noteTurn();
				if (assistant === undefined) break;
				if (assistant.stopReason === "error") {
					error = assistant.errorMessage ?? "provider error";
					break;
				}
				const toolCalls = assistant.content.filter((c): c is ToolCall => c.type === "toolCall");
				// Set when every call in this turn's batch asked to end the run.
				let allTerminate = false;
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
					allTerminate = await this.executeToolBatch(toolCalls, turn);
					if (!allTerminate) {
						// The checkpoint after a tool batch: steering lands here, so the
						// very next request carries it. Follow-ups wait for a boundary
						// that could end the run.
						const { steers: afterTools } = this.kernel.takeAtBoundary({ followUpWhenNoTrigger: false });
						if (afterTools.length > 0) this.adopt(afterTools);
					}
				}
				// The turn had tool work: keep looping unless the batch asked to end
				// the run (eta-agent's allTerminate checkpoint). A message injected
				// mid-run never interrupts; it opens the next turn via the drain at
				// the top of the loop.
				if (allTerminate) break;
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
		if (error !== undefined) status = "failed";
		// The one place the loop waits for the disk: a finished run is a durable
		// run. Commits were started as messages landed and are not awaited — the
		// runner never blocks on storage (§3 ruling 6). This runs even when the
		// run threw, so what was recorded before the fault is still written.
		await this.journal?.flush().catch(() => undefined);
		const result: RunResult = { turns: this.kernel.turns, status, ...(error === undefined ? {} : { error }) };
		this.emit("turn:run-end", {
			runId,
			turns: result.turns,
			endedAt: Date.now(),
			status,
			...(error === undefined ? {} : { error }),
		});
		return result;
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

	/**
	 * Add a message to the transcript and tell the journal. The runner does not
	 * write anything down itself (§3 ruling 6): the journaling subscriber does,
	 * and announces the entry id once it has one.
	 */
	private push(message: AgentMessage): void {
		this.transcript.push(message);
		this.emit("message:end", { message });
	}

	/** Adopt accepted inbox items into the transcript and the journal. */
	private adopt(items: readonly QueuedItem[]): void {
		for (const item of items) {
			this.transcript.push(item.message);
			this.emit("message:end", { message: item.message });
		}
		if (items.length > 0) this.emit("queue:update", { queues: this.kernel.inbox.list() });
	}

	private async takeTurn(model: Model<Api>): Promise<AssistantMessage | undefined> {
		const runId = this.currentRunId ?? "";
		const turnId = this.currentTurnId ?? "";
		const toolContext = await this.resolveToolContext();
		const systemPrompt = await this.resolveSystemPrompt(toolContext);
		// Resolved once per turn: the context is assembled twice (once to estimate what
		// it will cost, once to send it), and a transient message is one turn's worth of
		// state — reading the seam twice would let the estimate consume a reminder that
		// then never reaches the model.
		const transient = this.resolveTransientMessages();
		this.emit("turn:start", {
			runId,
			turnId,
			contextParts: this.estimateParts(this.assembleContext(toolContext, systemPrompt, transient)),
		});

		const config = this.config.get();
		// Everything that can go wrong mid-generation is generateWithRetry's
		// business; the loop below only sees the message that settled it.
		const assistant = await generateWithRetry({
			models: this.models,
			model,
			streamOptions: config.streamOptions,
			thinkingLevel: config.thinkingLevel,
			signal: this.runSignal(),
			retryPolicy: config.retryPolicy,
			runId,
			turnId,
			intendedOutputLimit: model.maxTokens ?? 0,
			contextFor: () => this.assembleContext(toolContext, systemPrompt, transient),
			emit: this.emit,
			observer: {
				update: (message, event) => {
					// Every frame is a snapshot: nothing downstream may hold a live
					// reference into the provider's in-flight message.
					this.emit("message:update", {
						runId,
						turnId,
						message: structuredClone(message),
						event: structuredClone(event),
					});
				},
			},
			recoverOverflow: () => this.compaction?.overflow() ?? Promise.resolve(false),
		});

		// A failed generation is not history: eta-agent records no entry for it, and
		// a failed message in the transcript would be sent back to the model.
		if (assistant.stopReason !== "error" && assistant.stopReason !== "aborted") {
			// The subscriber records this and writes the usage row for the turn.
			this.transcript.push(assistant);
			this.emit("message:end", { runId, message: assistant });
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
	private async executeToolBatch(calls: readonly ToolCall[], turn: number): Promise<boolean> {
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
				onUpdate: (updated, partial, updateOptions) => {
					// A progress report is a snapshot, like every other payload: the
					// clone keeps a mutable partial out of the bus.
					this.emit("tool:update", {
						runId,
						turnId,
						toolCallId: updated.id,
						toolName: updated.name,
						partialResult: structuredClone(partial),
						...(updateOptions?.checkpoint === true ? { checkpoint: true } : {}),
					});
				},
				// Every tool call is an effect: once the run is aborting, no new one
				// is admitted, and the call reports the cancellation instead of running.
				admit: gate === undefined ? <T>(work: () => T) => work() : <T>(work: () => T) => gate.admit(work),
				track: <T>(work: Promise<T>) => this.track(work),
			},
		);
		let allTerminate = outcomes.length > 0;
		for (const outcome of outcomes) {
			const call = calls.find((candidate) => candidate.id === outcome.id)!;
			const terminate = isTerminatingResult(outcome.result);
			if (!terminate) allTerminate = false;
			await this.recordToolResult(call, outcome.result, started.get(outcome.id) ?? Date.now(), terminate);
		}
		return allTerminate;
	}

	/** Emit the result event and put the tool result into the transcript. */
	private async recordToolResult(call: ToolCall, raw: unknown, startedAt: number, terminate: boolean): Promise<void> {
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
			terminate,
			durationMs,
		});
		const result = toToolResultMessage(call, raw);
		this.transcript.push(result);
		this.turnToolResults.push(result);
		this.emit("message:end", { runId, message: result, ...(terminate ? { terminate: true as const } : {}) });
	}

	/**
	 * One provider request: the prompt the caller composed, the transcript, and the
	 * tools this turn offers.
	 *
	 * The runner adds no prompt text of its own — not even the persona. Persona is
	 * *content*, and content belongs to whoever composes the prompt (the harness's
	 * composer puts it right after the base prompt, where a provider cache keeps it
	 * and where it cannot be duplicated). The harness renders the persona snapshot;
	 * `systemPrompt` here is used verbatim.
	 */
	/** The transient messages for this turn, read once (see `takeTurn`). */
	private resolveTransientMessages(): AgentMessage[] {
		const resolved = this.options.transientMessages?.();
		if (resolved === undefined) return [];
		return Array.isArray(resolved) ? [...(resolved as AgentMessage[])] : [resolved as AgentMessage];
	}

	private assembleContext(toolContext: unknown, systemPrompt: string, transient: readonly AgentMessage[]): Context {
		const prompt = systemPrompt;
		const tools: PiTool[] = this.activeTools().tools.map((tool) => ({
			name: tool.name,
			description: tool.description ?? "",
			parameters:
				(tool as unknown as { parameters?: PiTool["parameters"] }).parameters ?? ({} as PiTool["parameters"]),
		}));
		void toolContext;
		// Transient messages ride after the transcript: they are the newest thing the
		// model should read, and they exist for this request only.
		return {
			...(prompt.length > 0 ? { systemPrompt: prompt } : {}),
			messages: [...this.projectMessages(this.transcript), ...this.projectMessages(transient)],
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
		// `system` is the composed prompt as a whole; the prompt layer reports its own
		// per-block split (`etaPromptSectionsDetailed`), which is what a panel shows.
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

/** Whether a tool result asks for the run to end after this turn. */
/** A tool result with content blocks: what harness tools produce (text, images). */
interface StructuredToolResult {
	content: { type: string }[];
	details?: unknown;
	isError?: boolean;
}

/** Read a structured tool result, or `undefined` for anything else. */
function isStructuredToolResult(raw: unknown): StructuredToolResult | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const candidate = raw as { content?: unknown };
	if (!Array.isArray(candidate.content)) return undefined;
	const blocks = candidate.content.filter(
		(block): block is { type: string } =>
			typeof block === "object" && block !== null && typeof (block as { type?: unknown }).type === "string",
	);
	if (blocks.length === 0) return undefined;
	return raw as StructuredToolResult;
}

/** What the model sees for a tool that answered with something unstructured. */
function stringifyToolResult(raw: unknown): string {
	if (typeof raw === "string") return raw;
	try {
		return JSON.stringify(raw) ?? "";
	} catch {
		return String(raw);
	}
}

function isTerminatingResult(raw: unknown): boolean {
	return typeof raw === "object" && raw !== null && (raw as { terminate?: unknown }).terminate === true;
}

function isMessage(m: AgentMessage): m is Message {
	return m.role === "user" || m.role === "assistant" || m.role === "toolResult";
}

/**
 * A tool's return value as the transcript message a model reads.
 *
 * A tool may answer with text, or with the structured result a harness tool
 * produces: content blocks (text and images alike) plus details. Anything else is
 * stringified — a plugin that returns a bare object gets its JSON seen by the
 * model rather than a silently empty result. Shared with the side-request path,
 * so a tool result looks the same whether a run or a side ask produced it.
 */
export function toToolResultMessage(call: { id: string; name: string }, raw: unknown): AgentMessage {
	const isError = typeof raw === "object" && raw !== null && "isError" in raw && raw.isError === true;
	const structured = isStructuredToolResult(raw);
	return {
		role: "toolResult" as const,
		toolCallId: call.id,
		toolName: call.name,
		content:
			structured === undefined ? [{ type: "text" as const, text: stringifyToolResult(raw) }] : structured.content,
		...(structured?.details === undefined ? {} : { details: structured.details }),
		isError: structured?.isError ?? isError,
		timestamp: Date.now(),
	} as AgentMessage;
}
