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
 *
 * This is the harness's job rather than the kernel's: assembling a session means
 * knowing the services, and the services live here.
 *
 * Compaction arrives as a summarizer plugin. Passing one installs the driver;
 * passing none opens a session with no bound on its history, which is what "that
 * plugin is not installed" means. The two are different states on purpose: a
 * driver that exists always works, and one that cannot summarize throws
 * (`CompactionMisconfigured`) rather than acting like a history that fits.
 */

import type { CompactionSummarizer } from "@eta/core";
import {
	type AgentMessage,
	applyGoalEntries,
	defaultKernelConfig,
	type GoalEntry,
	Kernel,
	type KernelConfig,
	type KernelModels,
	type KernelOptions,
	kernelOn,
	Runner,
	type RunnerOptions,
	recordGoalEntries,
	SessionLog,
	type StorageService,
	type StoredTask,
} from "@eta/core";
import { CompactionService } from "./compaction-service";
import { JournalingService, SESSION_CONFIG, TASKS_STATE } from "./journaling";

export interface OpenSessionOptions {
	storage: StorageService;
	/** The model layer the runner generates through. */
	models: KernelModels;
	/**
	 * The summarizer this session compacts with, behind the harness's compaction
	 * service. Omit it for a session with no compaction at all — no driver, no
	 * threshold check, nothing between the history and the provider's window.
	 */
	compaction?: CompactionSummarizer;
	/**
	 * Everything a kernel takes, except the config and the journal: those come
	 * from the journal, or from `config` when it holds none.
	 */
	kernel?: Omit<KernelOptions, "journal" | "config">;
	/** What a brand-new session starts as. Ignored when the journal has a config. */
	config?: Partial<KernelConfig>;
	/** Runner options, minus the two this assembly supplies. */
	runner?: Omit<RunnerOptions, "models" | "initialTranscript" | "compaction">;
}

export interface OpenSession {
	kernel: Kernel;
	runner: Runner;
	log: SessionLog;
	/** The journal's owner: what wrote the entries this session replayed. */
	journaling: JournalingService;
	/**
	 * The compaction driver this session runs with; the host asks it to compact
	 * (`/compact`). Undefined when the session was opened without a summarizer.
	 */
	compaction: CompactionService | undefined;
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
	});

	// The journal's owner: one service per session, wired to the log this
	// assembly just replayed.
	const journaling = new JournalingService(kernel.ctx, {
		journal: log,
		config: kernel.config,
		tasks: kernel.tasks,
		...(options.kernel?.warn === undefined ? {} : { warn: options.kernel.warn }),
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

	// Compaction: the service decides, the runner only asks. The cut is taken on
	// the journal's entries, which the journaling service owns. No summarizer, no
	// driver: a session without the plugin runs unbound rather than pretending.
	const compaction =
		options.compaction === undefined
			? undefined
			: new CompactionService(kernel.ctx, {
					config: kernel.config,
					journaling,
					summarizer: options.compaction,
					...(options.kernel?.warn === undefined ? {} : { warn: options.kernel.warn }),
				});

	const transcript = log.transcript();
	const runner = new Runner(kernel, {
		...options.runner,
		models: options.models,
		journal: journaling,
		...(compaction === undefined ? {} : { compaction }),
		initialTranscript: transcript,
	});

	return {
		kernel,
		runner,
		log,
		journaling,
		compaction,
		transcript,
		orphans: log.orphans,
		config,
		configRestored: storedConfig !== undefined,
		tasks,
		stop,
	};
}
