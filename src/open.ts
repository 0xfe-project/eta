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
 * The system prompt is assembled here too, from the harness's own composer: the
 * base prompt, the active persona, the skills catalog, the platform briefing, and
 * the adaptive blocks (goal, tasks, memory) that are rewritten every generation.
 * The order is the cache's order — stable blocks first — and the adaptive ones are
 * re-read per request, so a note written a second ago is in the next prompt. A
 * caller that passes its own `runner.systemPrompt` overrides all of it.
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
	kernelEmit,
	kernelOn,
	Runner,
	type RunnerOptions,
	recordGoalEntries,
	SessionLog,
	type StorageService,
	type StoredTask,
	sessionScope,
	toToolResultMessage,
} from "@eta/core";
import { BtwManager, btwSideAsk } from "./btw";
import { CompactionService } from "./compaction-service";
import { JournalingService, SESSION_CONFIG, TASKS_STATE } from "./journaling";
import { MetricsService } from "./metrics";
import {
	composeEtaSystemPrompt,
	DEFAULT_SYSTEM_PROMPT,
	type EtaPromptSection,
	type EtaPromptState,
	etaPromptBlockChars,
	etaPromptSectionsDetailed,
	type PlatformPromptInfo,
	renderPlatformBlock,
	taskReminderMessage,
} from "./prompts";
import { RunPump, type RunPumpOptions } from "./pump";
import { TaskReminderService } from "./reminder";

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
	/** Runner options, minus the ones this assembly supplies. */
	runner?: Omit<RunnerOptions, "models" | "initialTranscript" | "compaction" | "journal">;
	/**
	 * The base prompt the composed system prompt starts from. Defaults to the
	 * harness's own (`DEFAULT_SYSTEM_PROMPT`); a product with its own voice passes
	 * its own, and nothing else changes about the assembly.
	 */
	baseSystemPrompt?: string | undefined;
	/**
	 * Facts for the platform briefing — **paths only**: the words live in
	 * `prompts/platform.ts`, and only the app knows where its config, session
	 * directories and project memory are. Rendered per generation, so a caller that
	 * learns something new about the session (memory now exists) can say so.
	 */
	platform?: PlatformPromptInfo | undefined;
	/**
	 * The rendered `<skills>` catalog block. Skill *discovery* is the app's (it knows
	 * the cwd, the home directory and the git roots); this is the block a session
	 * shows the model, and it is stable for the session.
	 */
	skillsSection?: string | undefined;
	/**
	 * The memory block, re-read per generation. The caller owns where memory comes
	 * from (`MemoryCache` over `.eta/MEMORY.md` is the usual answer) so a session can
	 * run without any memory at all.
	 */
	memorySource?: (() => string | undefined | Promise<string | undefined>) | undefined;
	/** How the idle waker reports a run it started that then failed. */
	pump?: RunPumpOptions;
	/** Turns without a task-tool call before the reminder nudge is due. */
	reminderInterval?: number | undefined;
}

export interface OpenSession {
	kernel: Kernel;
	runner: Runner;
	log: SessionLog;
	/** The journal's owner: what wrote the entries this session replayed. */
	journaling: JournalingService;
	/** Observable numbers for this session (tokens/sec, and what they are made of). */
	metrics: MetricsService;
	/** The task-reminder cadence; the prompts plugin reads its signal. */
	taskReminder: TaskReminderService;
	/**
	 * The idle waker, built and not started: whether an inject should become a run
	 * is the host's policy, so the host calls `start()`.
	 */
	pump: RunPump;
	/** The side threads asked beside the run; their saved notes are journal entries. */
	btw: BtwManager;
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
	/**
	 * The prompt as it stands right now: its named blocks, and how many characters
	 * are cacheable against rewritten. What a prompt panel reads.
	 */
	promptSections: () => Promise<{ sections: EtaPromptSection[]; stableChars: number; adaptiveChars: number }>;
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

	// The harness's own services live in their own scope too, for the same reason
	// the kernel's do: two sessions under one root are two sessions.
	const servicesCtx = sessionScope(kernel.ctx, ["compaction", "journaling", "metrics", "taskReminder"]);

	// The journal's owner: one service per session, wired to the log this
	// assembly just replayed.
	const journaling = new JournalingService(servicesCtx, {
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
			: new CompactionService(servicesCtx, {
					config: kernel.config,
					journaling,
					summarizer: options.compaction,
					...(options.kernel?.warn === undefined ? {} : { warn: options.kernel.warn }),
				});

	const metrics = new MetricsService(servicesCtx);
	const taskReminder = new TaskReminderService(servicesCtx, {
		tasks: kernel.tasks,
		...(options.reminderInterval === undefined ? {} : { reminderInterval: options.reminderInterval }),
	});

	const transcript = log.transcript();
	const runner = new Runner(kernel, {
		// The caller's runner options come first, so an explicit `systemPrompt` from
		// the host wins over the assembly below.
		...options.runner,
		models: options.models,
		journal: journaling,
		...(compaction === undefined ? {} : { compaction }),
		initialTranscript: transcript,
		...(options.runner?.systemPrompt === undefined
			? { systemPrompt: async () => composeEtaSystemPrompt(base, await promptState()) }
			: {}),
		// The cadence's nudge rides with the request it was due for: drained once, so a
		// turn that is never sent does not spend it, and never written to the transcript
		// (which is what keeps it out of the journal, out of compaction's view, and out
		// of the cacheable prefix).
		transientMessages: () => (taskReminder.drain() ? taskReminderMessage() : undefined),
	});

	// The prompt: composed per request so the adaptive blocks are current, in the
	// order a provider cache wants (stable first). A caller's own runner prompt
	// overrides this entirely — the harness supplies a default, not a policy.
	const base = options.baseSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;
	const promptState = async (): Promise<EtaPromptState> => {
		const persona = kernel.persona.renderActive().text;
		const memory = options.memorySource === undefined ? undefined : await options.memorySource();
		return {
			...(kernel.goal.current === undefined
				? {}
				: { goal: { objective: kernel.goal.current.objective, status: kernel.goal.current.status } }),
			tasks: kernel.tasks.list(),
			...(persona.length === 0 ? {} : { persona }),
			...(options.skillsSection === undefined || options.skillsSection.length === 0
				? {}
				: { skills: options.skillsSection }),
			...(options.platform === undefined ? {} : { platform: renderPlatformBlock(options.platform) }),
			...(memory === undefined || memory.length === 0 ? {} : { memory }),
		};
	};
	const promptSections = async () => {
		const state = await promptState();
		const blocks = etaPromptBlockChars(base, state);
		return { sections: etaPromptSectionsDetailed(base, state), ...blocks };
	};

	const pump = new RunPump(kernel, runner, options.pump);

	// Side threads. What they inherit is the run's own request state, read per
	// question; what they leave behind is a note in the journal, never a message in
	// the transcript. Their tools go through the kernel's own chain, so a side
	// request cannot reach anything the run could not.
	const btw = new BtwManager({
		buildContext: (entries) => ({
			messages: entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
		}),
		onVisibleNote: async (note) => {
			await journaling.recordNote(note);
		},
		observe: kernelEmit(kernel.ctx),
		sideAsk: btwSideAsk({
			models: options.models,
			requestState: () => runner.requestState(),
			executeTool: async (call, info) =>
				toToolResultMessage(
					call,
					await kernel.tools.execute(call.name, call.arguments, {
						turn: info.turn,
						toolCallId: call.id,
						...(info.toolContext === undefined ? {} : { toolContext: info.toolContext }),
					}),
				),
			onUsage: (usage, threadId) => {
				void journaling.recordUsage(usage, { details: { source: "btw", threadId } }).catch(() => undefined);
			},
		}),
	});
	// Threads the journal still speaks for: a saved note comes back as a thread.
	btw.replay(log.graph.pathOldestFirst());

	return {
		kernel,
		runner,
		log,
		journaling,
		metrics,
		taskReminder,
		pump,
		btw,
		promptSections,
		compaction,
		transcript,
		orphans: log.orphans,
		config,
		configRestored: storedConfig !== undefined,
		tasks,
		stop,
	};
}
