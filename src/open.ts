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

import type { CompactionSummarizer, KernelTool } from "@eta/core";
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
import type { TSchema } from "typebox";
import { AskRegistry, createAskUserTool } from "./ask";
import { BtwManager, btwSideAsk } from "./btw";
import { CompactionService } from "./compaction-service";
import type { ExecutionEnv } from "./env/types";
import { JournalingService, SESSION_CONFIG, TASKS_STATE } from "./journaling";
import {
	extractMemoryAtRunEnd,
	MemoryCache,
	type MemoryExtractionOutcome,
	type MemoryFile,
	type MemoryFs,
} from "./memory";
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
import { sessionStateKV } from "./state";
import type { SubagentManager } from "./subagent";
import { createBashTool } from "./tools/bash";
import type { ExecutionToolContext } from "./tools/context";
import { createEditTool } from "./tools/edit";
import { createReadTool } from "./tools/read";
import { createStateTools } from "./tools/state";
import { createSubagentTools } from "./tools/subagents";
import { createTaskTools } from "./tools/tasks";
import { type HarnessTool, type ToolResult, toKernelTool } from "./tools/tool";
import { createWriteTool } from "./tools/write";

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
	/**
	 * The execution environment to install the file and shell tools for. Without one
	 * a session has no read/write/edit/bash — there is nothing to run them against —
	 * and that is a legitimate session (a subagent, a sandbox, a side thread).
	 */
	env?: ExecutionEnv | undefined;
	/**
	 * The ask channel. `true` installs `ask_user` with the session owning the
	 * registry (see `OpenSession.ask`); passing a registry the host built keeps the
	 * host's own answer policy, but then the host is also the one recording answers.
	 */
	ask?: boolean | AskRegistry | undefined;
	/** How long `ask_user` waits for a human. Defaults to no timeout. */
	askTimeoutMs?: number | undefined;
	/** The subagent pool. With one, a session can spawn children; without it, it cannot. */
	subagents?: SubagentManager | undefined;
	/**
	 * Extra tools, appended after the standard set and installed the same way. A
	 * deployment that adds a tool does not have to assemble the standard ones itself.
	 */
	tools?: readonly HarnessTool<ExecutionToolContext, TSchema, unknown>[] | undefined;
	/**
	 * The project's memory, wired end to end: the block is read (and re-read when a
	 * file changes), and what is worth keeping is asked for at the end of a run.
	 * Supplying this replaces `memorySource`.
	 */
	memory?: SessionMemoryOptions | undefined;
	/** How the idle waker reports a run it started that then failed. */
	pump?: RunPumpOptions;
	/** Turns without a task-tool call before the reminder nudge is due. */
	reminderInterval?: number | undefined;
}

/** The project's memory, as a session needs it: where it is, and how to write it. */
export interface SessionMemoryOptions {
	/** How memory is reached: `envMemoryFs(env)` for a session with an environment. */
	fs: MemoryFs;
	/** The project's working directory; memory is scanned up from here. */
	cwd: string;
	/** The agent's home, for the `~/.eta` label. Optional. */
	home?: string | undefined;
	/**
	 * The one-shot call the extraction makes. Without it memory is read and never
	 * written — a session without a model that may spend tokens on notes.
	 */
	call?: ((systemPrompt: string, prompt: string) => Promise<string>) | undefined;
	/** Under this many characters of conversation, no extraction is attempted. */
	minTranscriptChars?: number | undefined;
	/** Where an extraction's outcome is reported (a log line, a panel). */
	onExtraction?: ((outcome: MemoryExtractionOutcome) => void) | undefined;
}

export interface OpenSession {
	kernel: Kernel;
	/**
	 * The tools this assembly installed, by name — what `activeToolNames` was pinned
	 * to when the journal did not already say.
	 */
	tools: string[];
	/**
	 * The ask channel: what a UI answers through (`answer(questionId, response)`,
	 * `pendingAsks()`), and what a restart re-surfaces questions from. Present when the
	 * session was opened with `ask`; the session records both halves of the exchange,
	 * so a replay can tell what is still waiting.
	 */
	ask: AskRegistry | undefined;
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
	/** The configuration the session is on right now (a live read, not a snapshot). */
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
	/** The project's memory, when the session was opened with one. */
	memory: MemoryCache | undefined;
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

	// The standard battery: what a session is for. It is assembled here rather than by
	// every host because "a session" means the same set of capabilities everywhere —
	// and what is *absent* is expressed by what was passed in (no env, no file tools;
	// no pool, no children), not by leaving pieces of the battery out.
	// The ask channel: one registry per session, recording both halves of the
	// exchange — the question before it waits (so a killed process still has it) and
	// the answer when it lands (so a replay never re-surfaces a settled question).
	const ask =
		options.ask === true
			? new AskRegistry({
					onAnswer: (payload) => {
						void journaling.recordAnswer(payload);
					},
				})
			: options.ask === undefined || options.ask === false
				? undefined
				: options.ask;

	const installedTools: HarnessTool<ExecutionToolContext, TSchema, unknown>[] = [
		...(createTaskTools(kernel.tasks) as HarnessTool<ExecutionToolContext, TSchema, unknown>[]),
		...(options.env === undefined
			? []
			: [
					createReadTool() as HarnessTool<ExecutionToolContext, TSchema, unknown>,
					createWriteTool() as HarnessTool<ExecutionToolContext, TSchema, unknown>,
					createEditTool() as HarnessTool<ExecutionToolContext, TSchema, unknown>,
					createBashTool() as HarnessTool<ExecutionToolContext, TSchema, unknown>,
				]),
		...(createStateTools(sessionStateKV(log, journaling)) as HarnessTool<ExecutionToolContext, TSchema, unknown>[]),
		...(options.subagents === undefined
			? []
			: (createSubagentTools(options.subagents) as HarnessTool<ExecutionToolContext, TSchema, unknown>[])),
		...(ask === undefined
			? []
			: [
					createAskUserTool({
						registry: ask,
						// The entry lands before the wait: that is what makes a question
						// survive the process that asked it.
						onAsk: async (payload) => {
							await journaling.recordAsk(payload);
						},
						...(options.askTimeoutMs === undefined ? {} : { timeoutMs: options.askTimeoutMs }),
					}) as HarnessTool<ExecutionToolContext, TSchema, unknown>,
				]),
		...(options.tools ?? []),
	];
	const env = options.env;
	for (const tool of installedTools) {
		kernel.tools.register(
			toKernelTool(tool, () => ({ env }) as ExecutionToolContext) as KernelTool<unknown, ToolResult<unknown>>,
		);
	}
	// A question that was waiting when the process died is waiting again.
	ask?.replay(log.graph.pathOldestFirst());

	// What the model may call. A session whose journal already chose a set keeps it —
	// a narrower toolset is a decision somebody made, not something to overwrite — and
	// a name that is not installed is reported rather than silently dropped.
	const installedNames = installedTools.map((tool) => tool.name);
	if (kernel.config.read("activeToolNames").length === 0) {
		kernel.config.update({ activeToolNames: installedNames });
	} else {
		const missing = kernel.config.read("activeToolNames").filter((name) => !installedNames.includes(name));
		if (missing.length > 0) {
			// Not an error: the session may have been configured by a deployment that had
			// more (or other) tools. The run reports the gap when it builds its request.
			options.kernel?.warn?.(
				`[eta-harness] tools this session was configured for are not installed: ${missing.join(", ")}`,
			);
		}
	}

	// The ledger comes back from its value, malformed rows and all.
	const storedTasks = (await options.storage.getValue(TASKS_STATE))?.value as StoredTask[] | undefined;
	const tasks = storedTasks === undefined ? undefined : kernel.tasks.restore(storedTasks);

	// A goal that is only in memory is a goal a restart loses: wire its journaling
	// with the session, so every transition lands as an entry.
	const { stop: stopGoalEntries } = recordGoalEntries(log, kernelOn(kernel.ctx));

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
		// What the built-in tools see: the environment this session runs on. A caller
		// that supplies its own resolution keeps it.
		...(options.env === undefined || options.runner?.toolContext !== undefined
			? {}
			: { toolContext: () => ({ env: options.env }) as ExecutionToolContext }),
	});

	// Memory: one cache per session, so the block is re-read when a file changes and
	// the extraction writes exactly where the block reads. The cache is the only
	// reader — a note written a moment ago has to be in the next prompt.
	const memory =
		options.memory === undefined ? undefined : new MemoryCache(options.memory.fs, options.memory.home ?? "");
	const memoryTarget: MemoryFile | undefined =
		options.memory === undefined ? undefined : (await memory!.load(options.memory.cwd)).target;

	// The prompt: composed per request so the adaptive blocks are current, in the
	// order a provider cache wants (stable first). A caller's own runner prompt
	// overrides the whole thing — the harness supplies a default, not a policy.
	const base = options.baseSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;
	const promptState = async (): Promise<EtaPromptState> => {
		const persona = kernel.persona.renderActive().text;
		const memoryBlock =
			memory === undefined ? await options.memorySource?.() : (await memory.load(options.memory!.cwd)).text;
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
			...(memoryBlock === undefined || memoryBlock.length === 0 ? {} : { memory: memoryBlock }),
		};
	};
	const promptSections = async () => {
		const state = await promptState();
		const blocks = etaPromptBlockChars(base, state);
		return { sections: etaPromptSectionsDetailed(base, state), ...blocks };
	};

	// The end of a run is when a stretch of work stops being read: ask what was worth
	// keeping. Off the run's critical path (the boundary does not wait for it) and
	// never fatal — a provider that is down costs a note, not a turn.
	const memoryOptions = options.memory;
	const stopExtraction =
		memoryOptions?.call === undefined || memoryTarget === undefined
			? undefined
			: kernelOn(kernel.ctx)("turn:run-end", () => {
					void extractMemoryAtRunEnd(
						{
							fs: memoryOptions.fs,
							target: memoryTarget,
							call: memoryOptions.call!,
							...(memoryOptions.minTranscriptChars === undefined
								? {}
								: { minTranscriptChars: memoryOptions.minTranscriptChars }),
						},
						// The journal is the transcript of record: what a run wrote is what
						// the extraction reads, whether or not the host kept its own copy.
						journaling.transcript(),
						memoryOptions.onExtraction,
					);
				});

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
		memory,
		tools: installedTools.map((tool) => tool.name),
		ask,
		promptSections,
		compaction,
		transcript,
		orphans: log.orphans,
		config: kernel.config.get(),
		configRestored: storedConfig !== undefined,
		tasks,
		stop: () => {
			stopExtraction?.();
			stopGoalEntries();
		},
	};
}
