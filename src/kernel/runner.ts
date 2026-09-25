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
import type { Api, AssistantMessage, Context, Message, Model, Tool as PiTool, ToolCall } from "@earendil-works/pi-ai";
import type { Emit } from "../types/events.ts";
import { kernelEmit, kernelOn } from "../types/events.ts";
import type { AgentMessage } from "../types/messages.ts";
import type { GoalService } from "./goal.ts";
import type { Kernel } from "./kernel.ts";
import type { PersonaService } from "./persona.ts";
import type { ProviderSeam } from "./providers.ts";
import type { ToolService } from "./tools.ts";

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
	providers: ProviderSeam;
	model: Model<Api>;
	/** Static system-prompt blocks (plugins contribute via persona/prompt seams later). */
	systemPrompt?: string;
	thinkingLevel?: string;
	/** Run-boundary decisions (REFACTOR.md §2.4 step 5); without it the boundary is a plain stop. */
	boundary?: RunnerBoundaryOptions;
	/**
	 * When true, an inject arriving while the runner is idle immediately starts
	 * a new run (REFACTOR.md §2.5). The server turns this on for live sessions;
	 * one-shot callers (subagents) leave it off.
	 */
	autoPump?: boolean;
}

export interface RunResult {
	turns: number;
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
	private readonly emit: Emit;
	private readonly transcript: AgentMessage[] = [];
	private emptyStops = 0;
	private pumping = false;
	private inFlight: Promise<RunResult> | undefined;
	private autoPumpOff: (() => boolean) | undefined;

	constructor(kernel: Kernel, options: RunnerOptions) {
		this.kernel = kernel;
		this.options = options;
		this.emit = kernelEmit(kernel.ctx);
		this.tools = kernel.tools;
		this.goal = kernel.goal;
		this.persona = kernel.persona;
		if (options.autoPump) {
			this.autoPumpOff = kernelOnAuto(kernel.ctx, () => {
				if (!this.pumping && this.kernel.injectQueueDepth > 0) {
					void this.run();
				}
			});
		}
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
		this.pumping = true;
		for (;;) {
			this.drainInjected();
			const turn = this.kernel.turns + 1;
			const assistant = await this.takeTurn(turn);
			if (assistant === undefined) break;
			if (assistant.stopReason === "error") {
				error = assistant.errorMessage ?? "provider error";
				break;
			}
			const toolCalls = assistant.content.filter((c): c is ToolCall => c.type === "toolCall");
			if (toolCalls.length === 0) {
				// Run boundary: de-hooked (REFACTOR.md §2.4 step 5) — the runner asks
				// the goal directly instead of waiting for a followUp hook slot.
				if (!(await this.atRunBoundary(assistant))) {
					// A message may have arrived while the boundary was deciding
					// (or during the evaluator's async call): it opens a new turn
					// instead of ending the run underneath it.
					if (this.kernel.injectQueueDepth > 0) continue;
					break;
				}
			} else {
				for (const call of toolCalls) {
					await this.executeToolCall(call, turn);
				}
			}
			if (!this.kernel.noteTurn()) break;
			// The turn had tool work: keep looping. A message injected mid-run
			// (tool or middleware) never interrupts; it opens the next turn via
			// the drain at the top of the loop.
		}
		this.pumping = false;
		const result: RunResult = { turns: this.kernel.turns, error };
		this.emit("turn:run-end", { turns: result.turns, usage: zeroUsage() });
		if (this.options.autoPump && this.kernel.injectQueueDepth > 0 && error === undefined) {
			// An inject raced with the run-end above; pump it immediately.
			return this.run();
		}
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
				this.transcript.push(boundary.nudgeEmpty());
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
		this.transcript.push(boundary.nudgeGoal());
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

	private drainInjected(): void {
		for (const message of this.kernel.drainInjected()) {
			this.transcript.push(message);
		}
	}

	private async takeTurn(turn: number): Promise<AssistantMessage | undefined> {
		const context = this.assembleContext();
		this.emit("turn:start", { turn, contextParts: this.estimateParts(context) });
		const assistant = await this.options.providers.complete(this.options.model, context, {
			reasoning: this.options.thinkingLevel,
		} as never);
		this.transcript.push(assistant);
		this.emit("turn:end", { turn, usage: assistant.usage, stopReason: assistant.stopReason });
		return assistant;
	}

	private async executeToolCall(call: ToolCall, turn: number): Promise<void> {
		this.emit("tool:call", { name: call.name, args: call.arguments, turn });
		const started = Date.now();
		const raw = await this.tools.execute(call.name, call.arguments, { turn, toolCallId: call.id });
		const durationMs = Date.now() - started;
		this.emit("tool:result", { name: call.name, result: raw, durationMs, turn });
		const isError = typeof raw === "object" && raw !== null && "isError" in raw && raw.isError === true;
		const text = typeof raw === "string" ? raw : JSON.stringify(raw);
		this.transcript.push({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text }],
			isError,
			timestamp: Date.now(),
		} as AgentMessage);
	}

	private assembleContext(): Context {
		const personaBlock = this.persona.renderActive().text;
		const systemPrompt = [this.options.systemPrompt ?? "", personaBlock].filter((s) => s.length > 0).join("\n\n");
		const tools: PiTool[] = this.tools.list().map((t) => ({
			name: t.name,
			description: t.description ?? "",
			parameters: (t as unknown as { parameters?: PiTool["parameters"] }).parameters ?? ({} as PiTool["parameters"]),
		}));
		return {
			...(systemPrompt.length > 0 ? { systemPrompt } : {}),
			messages: this.transcript.filter(isMessage),
			tools,
		};
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

function kernelOnAuto(ctx: Parameters<typeof kernelOn>[0], onInject: () => void): () => boolean {
	return kernelOn(ctx)("inject:received", onInject);
}

function isMessage(m: AgentMessage): m is Message {
	return m.role === "user" || m.role === "assistant" || m.role === "toolResult";
}

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
