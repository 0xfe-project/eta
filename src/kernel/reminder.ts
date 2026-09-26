/**
 * TaskReminderService — the task-reminder cadence as a subscriber (ported from
 * eta-agent's createReminderHooks + cadence.ts).
 *
 * The cadence is pure arithmetic over two facts: how many turns have passed,
 * and when a task tool was last used. Both are already on the bus, so nothing
 * about it belongs in the turn loop — the runner counts turns for its own
 * reasons, not for this.
 *
 * The kernel owns the signal (`task:reminder-due`); the prompts plugin owns
 * the text and the injection. Nothing here lands in the transcript: a reminder
 * is transient by design, so the cache prefix stays intact.
 */
import { type Context, Service } from "cordis";
import type { Emit } from "../types/events";
import { kernelEmit, kernelOn } from "../types/events";
import {
	type CadenceConfig,
	type CadenceState,
	createCadenceState,
	DEFAULT_REMINDER_INTERVAL,
	DEFAULT_TASK_TOOL_NAMES,
	drainReminderForContext,
	evaluateToolResult,
	onTurnStart,
} from "./cadence";
import type { TaskService } from "./tasks";

export interface TaskReminderServiceOptions {
	/** The task ledger: a reminder is only due when there is something to review. */
	tasks: TaskService;
	/** Turns without a task-tool call before a reminder is considered due. */
	reminderInterval?: number;
	/** Tool names that reset the cadence. Defaults to the task tools. */
	taskToolNames?: ReadonlySet<string>;
}

export class TaskReminderService extends Service {
	static readonly provide = "taskReminder";

	private readonly tasks: TaskService;
	private readonly emit: Emit;
	private readonly config: CadenceConfig;
	private readonly state: CadenceState = createCadenceState();
	private readonly offs: (() => boolean)[] = [];

	constructor(ctx: Context, options: TaskReminderServiceOptions) {
		super(ctx, "taskReminder");
		this.tasks = options.tasks;
		this.emit = kernelEmit(ctx);
		this.config = {
			reminderInterval: options.reminderInterval ?? DEFAULT_REMINDER_INTERVAL,
			taskToolNames: options.taskToolNames ?? DEFAULT_TASK_TOOL_NAMES,
		};
		const on = kernelOn(ctx);
		this.offs.push(
			on("turn:start", () => {
				onTurnStart(this.state);
			}),
			on("tool:end", (event) => {
				const due = evaluateToolResult(this.state, event.toolName, this.tasks.list().length > 0, this.config);
				if (due.markDue) this.emitDue();
			}),
		);
	}

	/** The cadence's current state, for a panel that wants to show it. */
	get cadence(): Readonly<CadenceState> {
		return this.state;
	}

	/**
	 * Take a pending reminder. True once per cycle: the prompts plugin asks for
	 * it when it assembles a request, and the cadence goes quiet until a task
	 * tool is used again.
	 */
	drain(): boolean {
		return drainReminderForContext(this.state);
	}

	/** Stop listening (a host that takes the session over). */
	stop(): void {
		for (const off of this.offs.splice(0)) off();
	}

	private emitDue(): void {
		this.emit("task:reminder-due", { turn: this.state.currentTurn });
	}
}
