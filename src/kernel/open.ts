/**
 * Opening a session (REFACTOR.md §K5).
 *
 * One path for both cases — a new session and a restart — because they are the
 * same thing: replay whatever the journal holds and hand back a kernel, a
 * runner, and the transcript. An empty journal yields an empty session, which is
 * what "start" means.
 *
 * What it restores, and from where:
 * - the entry graph and the branch tip       → the journal (SessionLog.load)
 * - the goal                                 → its entries, replayed
 * - the task ledger                          → the `eta.tasks.state` value
 * - the configuration                        → the `eta.session.config` value
 * - the transcript                           → the branch view of the graph
 * - usage totals and message count           → rebuilt by the storage layer
 *
 * It also wires the goal's journaling, because a goal that is only in memory is
 * a goal a restart loses: the primitive emits, this subscribes, the journal
 * keeps it.
 */

import { recordGoalEntries } from "../session/goal-journal";
import { SESSION_CONFIG, TASKS_STATE } from "../session/journaling";
import { SessionLog } from "../session/session-log";
import type { StorageService } from "../storage/types";
import type { KernelConfig } from "../types/config";
import { defaultKernelConfig } from "../types/config";
import type { GoalEntry } from "../types/entries";
import { kernelOn } from "../types/events";
import type { AgentMessage } from "../types/messages";
import type { StoredTask } from "../types/tasks";
import { applyGoalEntries } from "./goal";
import { Kernel, type KernelOptions } from "./kernel";
import type { KernelModels } from "./providers";
import { Runner, type RunnerOptions } from "./runner";

export interface OpenSessionOptions {
	storage: StorageService;
	/** The model layer the runner generates through. */
	models: KernelModels;
	/**
	 * Everything a kernel takes, except the config and the journal: those come
	 * from the journal, or from `config` when it holds none.
	 */
	kernel?: Omit<KernelOptions, "journal" | "config">;
	/** The one tool registry, when the host keeps a per-session service. */
	/** What a brand-new session starts as. Ignored when the journal has a config. */
	config?: Partial<KernelConfig>;
	/** Runner options, minus the two this assembly supplies. */
	runner?: Omit<RunnerOptions, "models" | "initialTranscript">;
}

export interface OpenSession {
	kernel: Kernel;
	runner: Runner;
	log: SessionLog;
	/** The transcript the journal replayed into, oldest first. */
	transcript: AgentMessage[];
	/** Entries whose parent the journal does not hold; their branch ends there. */
	orphans: number;
	/** The configuration the session resumes on. */
	config: KernelConfig;
	/** False when the journal held none and the caller's default was used. */
	configRestored: boolean;
	/** What the task restore kept, when the journal held a ledger. */
	tasks: { kept: number; dropped: string[] } | undefined;
	/** Stop the journaling this assembly wired (the host may want to take over). */
	stop: () => void;
}

/** Replay a journal and hand back a session ready to run. */
export async function openSession(options: OpenSessionOptions): Promise<OpenSession> {
	const log = await SessionLog.load(options.storage);

	// The journal's own words win; a caller's default is for a session that has
	// never been configured.
	const storedConfig = (await options.storage.getValue(SESSION_CONFIG))?.value;
	const config: KernelConfig = storedConfig ?? defaultKernelConfig(options.config);

	const kernel = Kernel.create({
		...options.kernel,
		config,
		journal: log,
	});

	// The goal comes back from its entries, in order.
	const goalEntries = log.graph.pathOldestFirst().filter((entry): entry is GoalEntry => entry.type === "goal");
	if (goalEntries.length > 0) applyGoalEntries(kernel.goal, goalEntries);

	// The ledger comes back from its value, malformed rows and all.
	const storedTasks = (await options.storage.getValue(TASKS_STATE))?.value as StoredTask[] | undefined;
	const tasks = storedTasks === undefined ? undefined : kernel.tasks.restore(storedTasks);

	// A goal that is only in memory is a goal a restart loses: wire its journaling
	// with the session, so every transition lands as an entry.
	const { stop } = recordGoalEntries(log, kernelOn(kernel.ctx));

	const transcript = log.transcript();
	const runner = new Runner(kernel, {
		...options.runner,
		models: options.models,
		initialTranscript: transcript,
	});

	return {
		kernel,
		runner,
		log,
		transcript,
		orphans: log.orphans,
		config,
		configRestored: storedConfig !== undefined,
		tasks,
		stop,
	};
}
