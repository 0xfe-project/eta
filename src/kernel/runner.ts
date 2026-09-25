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
import { kernelEmit } from "../types/events.ts";
import type { AgentMessage } from "../types/messages.ts";
import type { GoalService } from "./goal.ts";
import type { Kernel } from "./kernel.ts";
import type { PersonaService } from "./persona.ts";
import type { ProviderSeam } from "./providers.ts";
import type { ToolService } from "./tools.ts";

export interface RunnerOptions {
	providers: ProviderSeam;
	model: Model<Api>;
	/** Static system-prompt blocks (plugins contribute via persona/prompt seams later). */
	systemPrompt?: string;
	thinkingLevel?: string;
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

	constructor(kernel: Kernel, options: RunnerOptions) {
		this.kernel = kernel;
		this.options = options;
		this.emit = kernelEmit(kernel.ctx);
		this.tools = kernel.tools;
		this.goal = kernel.goal;
		this.persona = kernel.persona;
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
		let error: string | undefined;
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
				// Run boundary. t12 hangs goal.decide and the empty-response guard here.
				break;
			}
			for (const call of toolCalls) {
				await this.executeToolCall(call, turn);
			}
			if (!this.kernel.noteTurn()) break;
		}
		const result: RunResult = { turns: this.kernel.turns, error };
		this.emit("turn:run-end", { turns: result.turns, usage: zeroUsage() });
		return result;
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
