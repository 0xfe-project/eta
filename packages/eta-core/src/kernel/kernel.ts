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
import { JournalingService } from "../session/journaling";
import type { SessionLog } from "../session/session-log";
import type { KernelConfig } from "../types/config";
import { defaultKernelConfig } from "../types/config";
import type { Emit } from "../types/events";
import { kernelEmit } from "../types/events";
import type { AgentMessage } from "../types/messages";
import type { PersonaCard } from "../types/persona";
import type { StoredTask } from "../types/tasks";
import type { CompactionSummarizer } from "./compaction";
import { CompactionService } from "./compaction-service";
import { ConfigService } from "./config";
import type { GoalState } from "./goal";
import { GoalService } from "./goal";
import { Inbox, type QueuedItem } from "./inbox";
import { MetricsService } from "./metrics";
import { PersonaService } from "./persona";
import { TaskReminderService } from "./reminder";
import { TaskService } from "./tasks";
import { ToolService } from "./tools";

export interface KernelOptions {
	/** Upper bound on runner turns. `null` (default) runs until the turn loop settles. */
	maxTurns?: number | null;
	/** Parent context (the server's root). Defaults to a fresh root context. */
	parent?: Context;
	/** Initial configuration; the runner reads it live every turn. */
	config?: Partial<KernelConfig>;
	/** The summarizer behind compaction: a plugin, or nothing (every signal declines). */
	compaction?: CompactionSummarizer;
	/** Called when a summarizer throws; the run continues either way. */
	warn?: (message: string) => void;
	/**
	 * The journal this session writes to. The kernel does not create it: the host
	 * owns storage, and a session without one (a subagent, a throwaway) simply
	 * keeps nothing.
	 */
	journal?: SessionLog;
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
	inboxDepth: number;
}

export class Kernel {
	readonly ctx: Context;
	readonly goal: GoalService;
	readonly persona: PersonaService;
	readonly tasks: TaskService;
	readonly tools: ToolService;
	readonly config: ConfigService;
	/** Compaction: manual / threshold / overflow, and the replacement context. */
	readonly compaction: CompactionService;
	/** Durability as a subscriber: entries, usage rows, compaction entries. */
	readonly journaling: JournalingService;
	/** Observable numbers: tokens/sec, computed from the bus. */
	readonly metrics: MetricsService;
	/** The task-reminder cadence, watching the bus for turns and tool use. */
	readonly taskReminder: TaskReminderService;
	/** How the outside world reaches the loop (steer / followUp / nextRun). */
	readonly inbox = new Inbox();
	readonly maxTurns: number | null;

	private turnCount = 0;
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
		this.metrics = new MetricsService(this.ctx);
		this.taskReminder = new TaskReminderService(this.ctx, { tasks: this.tasks });
		this.journaling = new JournalingService(this.ctx, {
			...(options.journal === undefined ? {} : { journal: options.journal }),
			...(options.warn === undefined ? {} : { warn: options.warn }),
		});
		this.compaction = new CompactionService(this.ctx, {
			config: this.config,
			...(options.compaction === undefined ? {} : { summarizer: options.compaction }),
			...(options.warn === undefined ? {} : { warn: options.warn }),
		});
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
	 * top-level wake, and a child agent's output all arrive here: they queue as
	 * steering, so a run in flight changes course at its next boundary instead
	 * of being interrupted mid-turn, and an idle kernel starts a run for them.
	 */
	inject(message: AgentMessage): QueuedItem {
		const item = this.inbox.enqueue("steer", message);
		this.emit("inject:received", { message: item.message });
		return item;
	}

	/** Queue an input for the next boundary of the run in flight. */
	steer(message: string | AgentMessage, images?: Parameters<Inbox["enqueue"]>[2]): QueuedItem {
		return this.inbox.enqueue("steer", message, images);
	}

	/** Queue an input for when the run would otherwise stop. */
	followUp(message: string | AgentMessage, images?: Parameters<Inbox["enqueue"]>[2]): QueuedItem {
		return this.inbox.enqueue("followUp", message, images);
	}

	/** Queue an input for the next run, whenever that is. */
	nextRun(message: string | AgentMessage, images?: Parameters<Inbox["enqueue"]>[2]): QueuedItem {
		return this.inbox.enqueue("nextRun", message, images);
	}

	/** Drop a queued input; false when it was already consumed. */
	cancelQueued(entryId: string): boolean {
		return this.inbox.cancel(entryId);
	}

	/** What a run takes when it starts (the modes come from the live config). */
	acceptInbox(): QueuedItem[] {
		this.inbox.configure({
			steeringMode: this.config.read("steeringMode"),
			followUpMode: this.config.read("followUpMode"),
		});
		return this.inbox.accept();
	}

	/** What a boundary takes: steering, then follow-ups when nothing else continues. */
	takeAtBoundary(options: { followUpWhenNoTrigger: boolean }): { steers: QueuedItem[]; followUps: QueuedItem[] } {
		this.inbox.configure({
			steeringMode: this.config.read("steeringMode"),
			followUpMode: this.config.read("followUpMode"),
		});
		return this.inbox.takeAtBoundary(options);
	}

	get inboxDepth(): number {
		return this.inbox.depth;
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
			inboxDepth: this.inbox.depth,
		};
	}
}
