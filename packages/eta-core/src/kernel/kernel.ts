/**
 * Kernel — one session's runtime floor.
 *
 * A kernel is a cordis Context plus the three privileged primitives, the
 * inject() door, and the turn budget. Primitives are Service subclasses
 * constructed directly: they register through reflect.provide, never enter
 * the plugin registry, so the host cannot unload the floor out from under a
 * running agent (REFACTOR.md §2.1).
 *
 * There is deliberately no loop here, and no SealedFlags: what a subagent
 * must not do is expressed as absence — its kernel simply has no goal set,
 * no continuation driver, and no spawn tool (REFACTOR.md §1.4).
 */
import { Context } from "cordis";
import type { KernelConfig } from "../types/config.ts";
import { defaultKernelConfig } from "../types/config.ts";
import type { Emit } from "../types/events.ts";
import { kernelEmit } from "../types/events.ts";
import type { AgentMessage } from "../types/messages.ts";
import type { PersonaCard } from "../types/persona.ts";
import type { StoredTask } from "../types/tasks.ts";
import { ConfigService } from "./config.ts";
import type { GoalState } from "./goal.ts";
import { GoalService } from "./goal.ts";
import { PersonaService } from "./persona.ts";
import { TaskService } from "./tasks.ts";
import { ToolService } from "./tools.ts";

export interface KernelOptions {
	/** Upper bound on runner turns. `null` (default) runs until the turn loop settles. */
	maxTurns?: number | null;
	/** Parent context (the server's root). Defaults to a fresh root context. */
	parent?: Context;
	/** Initial configuration; the runner reads it live every turn. */
	config?: Partial<KernelConfig>;
}

export interface KernelInspect {
	config: KernelConfig;
	maxTurns: number | null;
	turns: number;
	budgetSpent: boolean;
	goal: GoalState | undefined;
	tasks: StoredTask[];
	tools: string[];
	personas: PersonaCard[];
	activePersonaNames: string[];
	injectQueueDepth: number;
}

export class Kernel {
	readonly ctx: Context;
	readonly goal: GoalService;
	readonly persona: PersonaService;
	readonly tasks: TaskService;
	readonly tools: ToolService;
	readonly config: ConfigService;
	readonly maxTurns: number | null;

	private turnCount = 0;
	private readonly injectQueue: AgentMessage[] = [];
	private readonly emit: Emit;

	private constructor(options: KernelOptions) {
		this.ctx = options.parent ? options.parent.extend() : new Context();
		this.maxTurns = options.maxTurns ?? null;
		this.emit = kernelEmit(this.ctx);
		this.goal = new GoalService(this.ctx);
		this.persona = new PersonaService(this.ctx);
		this.tasks = new TaskService(this.ctx);
		this.tools = new ToolService(this.ctx);
		this.config = new ConfigService(this.ctx, defaultKernelConfig(options.config));
	}

	static create(options: KernelOptions = {}): Kernel {
		return new Kernel(options);
	}

	get turns(): number {
		return this.turnCount;
	}

	/** Whether the turn budget is spent. Always false when `maxTurns` is null. */
	get budgetSpent(): boolean {
		return this.maxTurns !== null && this.turnCount >= this.maxTurns;
	}

	/**
	 * Report one finished turn. Returns whether another turn is still allowed,
	 * so the runner can ask at the turn boundary and stop on `false`.
	 */
	noteTurn(): boolean {
		this.turnCount += 1;
		return !this.budgetSpent;
	}

	/**
	 * The one door into the turn loop (REFACTOR.md §2.5). User input, a server-
	 * top-level wake, and a child agent's output all arrive here. The runner
	 * drains the queue when it reaches a run boundary.
	 */
	inject(message: AgentMessage): void {
		this.injectQueue.push(message);
		this.emit("inject:received", { message });
	}

	/** FIFO drain; the runner consumes what it can start turns with. */
	drainInjected(): AgentMessage[] {
		return this.injectQueue.splice(0, this.injectQueue.length);
	}

	get injectQueueDepth(): number {
		return this.injectQueue.length;
	}

	async dispose(): Promise<void> {
		await this.ctx.fiber.dispose();
	}

	inspect(): KernelInspect {
		return {
			config: structuredClone(this.config.get()) as KernelConfig,
			maxTurns: this.maxTurns,
			turns: this.turnCount,
			budgetSpent: this.budgetSpent,
			goal: this.goal.current,
			tasks: this.tasks.list(),
			tools: this.tools.names(),
			personas: this.persona.list(),
			activePersonaNames: this.persona.activeNamesList(),
			injectQueueDepth: this.injectQueue.length,
		};
	}
}
