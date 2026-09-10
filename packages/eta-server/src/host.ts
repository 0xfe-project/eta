/**
 * The bun-side host (v1 semantics, GUI-PLAN v2 W0.2): owns the agents, funnels
 * their three channels to subscribers, holds the single attach pointer. N
 * sessions run concurrently; loops and goals keep firing whether or not a
 * browser is connected, and disconnecting the GUI never stops the core.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	BACKGROUND_CONTEXT,
	EtaAgent,
	SessionViewProjector,
	type HarnessEvent,
	type LaneQueuedItem,
	type SessionView,
	type ThinkingLevel,
} from "@eta/core";
import {
	DevRing,
	encodeMessage,
	viewFingerprint,
	viewPatch,
	type ChannelFrame,
	type DevFrame,
	type SidebarSession,
} from "./protocol.ts";
import { ViewPacer } from "./view-pacer.ts";
import { configDefaultModel, etaConfigPath, loadEtaConfig, type EtaConfig } from "./config.ts";
import { createSessionAgent, type CreatedSession } from "./agent.ts";
import { renderPersonaFor } from "./personas.ts";

const AGENT_EVENT_TYPES = [
	"run_start",
	"run_end",
	"run_suspend",
	"run_resume",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_start",
	"tool_update",
	"tool_end",
	"entry_added",
	"queue_update",
	"usage",
	"retry_start",
	"retry_scheduled",
	"retry_end",
	"compaction_start",
	"compaction_end",
	"navigation_start",
	"navigation_end",
	"config_update",
	"value_update",
	"fault",
	"operation_abort",
	"handler_error",
] as const;

function userText(message: { role: string; content?: unknown; text?: string }): string {
	if (typeof message.text === "string" && message.text.length > 0) return message.text;
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		for (const block of message.content) {
			const record = block as { type?: string; text?: string };
			if (record.type === "text" && typeof record.text === "string") return record.text;
		}
	}
	return "";
}

export type AnswerFn = (questionId: string, response: Parameters<EtaAgent["ask"]["answer"]>[1]) => boolean;

interface Hosted {
	agent: EtaAgent;
	projector: SessionViewProjector;
	ring: DevRing;
	view: SessionView;
	/** Coalesces this session's view frames; see view-pacer.ts. */
	pacer: ViewPacer;
	running: boolean;
	queue: LaneQueuedItem[];
	cwd: string;
	updated: number;
	gitBranch?: string;
	persistDir?: string;
	created: CreatedSession;
	detach(): void;
}

export interface HostOptions {
	/** Override the ~/.eta/config.json location (tests run offline with this). */
	configPath?: string;
	/** Where per-session journals and meta.json live; defaults to ~/.eta/sessions. */
	dataDir?: string;
}

/**
 * View-frame budget. Measured on a live 675-message session: one snapshot is
 * 2.0MB and streaming pushed 21 of them per second — 42MB/s into a single browser
 * tab, whose main thread then could not answer a click for 200ms. A frame now
 * buys silence in proportion to its own size, so the wire stops costing more as a
 * conversation grows; the session in front keeps a tighter floor because that is
 * the streaming you are watching, and the ones behind it settle for a few updates
 * a second. See view-pacer.ts.
 */
const ATTACHED_VIEW_FLOOR_MS = 100;
const BACKGROUND_VIEW_FLOOR_MS = 600;
const VIEW_TARGET_BYTES_PER_SECOND = 4 * 1024 * 1024;

/** Levels the thinking chip offers; anything else in a settings POST is dropped. */
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Defaults new sessions start from, edited on the settings page and kept in
 * `<dataDir>/settings.json`. Deliberately narrow: only things that are useless
 * to change per message and have no better home.
 */
export interface SettingsFile {
	personaId?: string;
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
	keepRecentTokens?: number;
}

interface SessionMetaFile {
	personaId?: string;
	cwd?: string;
	modelId?: string;
	title?: string;
	pinned?: boolean;
	archived?: boolean;
	createdAt?: number;
}

export class Host {
	readonly configPath: string;
	readonly dataDir: string;
	private readonly hosted = new Map<string, Hosted>();

	constructor(options: HostOptions = {}) {
		this.configPath = options.configPath ?? etaConfigPath;
		this.dataDir = options.dataDir ?? join(homedir(), ".eta", "sessions");
	}

	private etaConfig(): EtaConfig {
		return loadEtaConfig(this.configPath) ?? {};
	}
	private readonly listeners = new Set<(frame: ChannelFrame, payload?: string) => void>();
	private attachPointerValue: string | null = null;

	get attachPointer(): string | null {
		return this.attachPointerValue;
	}

	focus(name: string): void {
		this.attachPointerValue = name;
		// Whoever just came to the front should not have to wait out a budget bought
		// by frames sent while it was in the background, and the client may have been
		// holding a frame from before the last reconnect.
		this.hosted.get(name)?.pacer.publishNow();
	}

	async createSession(name: string, personaId: string, cwd: string, modelId?: string): Promise<void> {
		if (this.hosted.has(name)) throw new Error(`session exists: ${name}`);
		const persistDir = join(this.dataDir, name);
		await mkdir(persistDir, { recursive: true });
		await writeFile(
			join(persistDir, "meta.json"),
			JSON.stringify({ personaId, cwd, ...(modelId === undefined ? {} : { modelId }), createdAt: Date.now() }),
			"utf8",
		);
		await this.open(
			name,
			() =>
				createSessionAgent({
					name,
					personaId,
					cwd,
					...(modelId === undefined ? {} : { modelId }),
					configPath: this.configPath,
					persistDir,
				}),
			{ cwd, persistDir },
		);
	}

	/** Reopen every persisted session so the sidebar and runs survive restarts. */
	async restoreSessions(): Promise<void> {
		let dirs: string[];
		try {
			dirs = await readdir(this.dataDir);
		} catch {
			return;
		}
		for (const dir of dirs) {
			if (this.hosted.has(dir)) continue;
			let meta: SessionMetaFile;
			try {
				meta = JSON.parse(await readFile(join(this.dataDir, dir, "meta.json"), "utf8")) as SessionMetaFile;
			} catch {
				continue;
			}
			if (meta.personaId === undefined) continue;
			const cwd = meta.cwd ?? process.cwd();
			const persistDir = join(this.dataDir, dir);
			this.meta.set(dir, {
				...(meta.title === undefined ? {} : { title: meta.title }),
				...(meta.pinned === true ? { pinned: true } : {}),
				...(meta.archived === true ? { archived: true } : {}),
				...(meta.modelId === undefined ? {} : { modelId: meta.modelId }),
			});
			try {
				await this.open(
					dir,
					() =>
						createSessionAgent({
							name: dir,
							personaId: meta.personaId!,
							cwd,
							...(meta.modelId === undefined ? {} : { modelId: meta.modelId }),
							configPath: this.configPath,
							persistDir,
						}),
					{ cwd, persistDir, restore: true },
				);
			} catch {
				/* a broken journal must not take the whole server down */
			}
		}
	}

	async open(
		name: string,
		create: () => Promise<CreatedSession>,
		options: { restore?: boolean; cwd?: string; persistDir?: string } = {},
	): Promise<void> {
		const made = await create();
		const agent = made.agent;
		if (options.restore === true) await agent.restore(BACKGROUND_CONTEXT);
		await agent.refreshPromptBlocks();
		const projector = new SessionViewProjector(agent);
		const ring = new DevRing();
		if (options.persistDir !== undefined) {
			try {
				const lines = (await readFile(join(options.persistDir, "dev.jsonl"), "utf8"))
					.split("\n")
					.filter((line) => line.length > 0);
				ring.seed(lines.slice(-512).map((line) => JSON.parse(line) as DevFrame));
			} catch {
				/* first boot for this session */
			}
		}
		const pacer = this.createViewPacer(name);
		const entry: Hosted = {
			agent,
			projector,
			ring,
			pacer,
			view: this.stampView({
				agent,
				projector,
				ring,
				pacer,
				view: null as unknown as SessionView,
				running: false,
				queue: [],
				cwd: options.cwd ?? process.cwd(),
				updated: Date.now(),
				persistDir: options.persistDir,
				created: made,
				detach: () => {},
			}),
			running: false,
			queue: [],
			cwd: options.cwd ?? process.cwd(),
			updated: Date.now(),
			gitBranch: undefined as string | undefined,
			persistDir: options.persistDir,
			created: made,
			detach: () => {},
		};
		this.hosted.set(name, entry);
		entry.view = this.stampView(entry, await projector.snapshot(BACKGROUND_CONTEXT));
		this.refreshBranch(name);
		for (const type of AGENT_EVENT_TYPES) {
			agent.harness.events.on(type, (event: HarnessEvent) => {
				// A run's boundaries are not traffic: the frame that opens one and the
				// frame that closes it are the ones somebody is waiting for, so both get
				// the budget forgiven and only the tokens in between are coalesced.
				if (type === "run_start") {
					entry.running = true;
					entry.pacer.relax();
				}
				// The projector refreshes on run_end as well, and that refresh is the
				// frame carrying "not running any more": forgive the budget so it is the
				// next one out rather than one queued behind the run's own traffic.
				if (type === "run_end") {
					entry.running = false;
					entry.pacer.relax();
				}
				if (type === "queue_update") {
					entry.queue = (event as { queues: LaneQueuedItem[] }).queues;
					entry.view = this.stampView(entry);
					this.publishView(name);
				}
				this.emit({ channel: "agent", session: name, event });
			});
		}
		agent.events.on("eta", (event) => {
			const frame: DevFrame = {
				ts: Date.now(),
				session: name,
				category: event.category,
				action: event.action,
				data: event.data,
			};
			entry.ring.push(frame);
			this.emit({ channel: "dev", frame });
			if (entry.persistDir !== undefined)
				void appendFile(join(entry.persistDir, "dev.jsonl"), `${JSON.stringify(frame)}\n`, "utf8").catch(
					() => undefined,
				);
		});
		const attached = await projector.attach((view) => {
			entry.view = this.stampView(entry, view);
			this.publishView(name);
		}, BACKGROUND_CONTEXT);
		entry.detach = attached.detach;
		this.attachPointerValue ??= name;
		// A session's first frame is not traffic, it is what the client has been
		// waiting for: send it, do not pace it.
		entry.pacer.publishNow();
	}

	/**
	 * The view channel of one session. The newest stamped view is encoded once per
	 * publish and the string is shared with every socket, so the server neither
	 * re-serializes a megabyte per tab nor ships an intermediate snapshot that no
	 * one will ever paint. While the journal stands still the frame that goes out is
	 * a patch: the transcript stays where it already is.
	 */
	private createViewPacer(name: string): ViewPacer {
		let published: SessionView | undefined;
		let pending: ChannelFrame | undefined;
		return new ViewPacer({
			minIntervalMs: () => (this.attachPointerValue === name ? ATTACHED_VIEW_FLOOR_MS : BACKGROUND_VIEW_FLOOR_MS),
			targetBytesPerSecond: () => VIEW_TARGET_BYTES_PER_SECOND,
			encode: (forced) => {
				const view = this.hosted.get(name)?.view;
				if (view === undefined || (!forced && view === published)) return undefined;
				published = view;
				// The transcript moves only with the journal. When the fingerprint says it did
				// not move, the frame leaves it out and carries the rest — which is what a
				// streaming token actually changes. Safe to assume every socket holds the same
				// messages because a socket's first view frame is always the whole one, sent
				// in the same synchronous block that adds it to the fan-out set.
				const next = viewFingerprint(view);
				const unchanged = this.viewFingerprints.get(name) === next;
				this.viewFingerprints.set(name, next);
				pending = unchanged
					? { channel: "view", session: name, patch: viewPatch(view) }
					: { channel: "view", session: name, view };
				return encodeMessage(pending);
			},
			deliver: (payload) => {
				if (pending !== undefined) this.emit(pending, payload);
			},
		});
	}

	/**
	 * What the transcript half of each session's last published frame looked like.
	 * Kept here rather than in the pacer's closure because a new connection has to
	 * sign for the whole view it is handed: every socket is promised one, and the
	 * frames after it may be patches onto exactly that.
	 */
	private readonly viewFingerprints = new Map<string, string>();

	/** Note that `view` was just sent to someone in full, so patches may follow it. */
	rememberView(name: string, view: SessionView): void {
		this.viewFingerprints.set(name, viewFingerprint(view));
	}

	/**
	 * Hand a freshly stamped view to the session's pacer.
	 *
	 * Only the stream is paced. While a run is in flight the projector fires per
	 * token, and that is the traffic worth shaping; anything that happens while the
	 * session is idle is one state change — a clicked op, the frame that closes a
	 * run — and a frame the user is waiting for is not traffic, so it goes out now.
	 */
	private publishView(name: string): void {
		const entry = this.hosted.get(name);
		if (entry === undefined) return;
		if (entry.running) entry.pacer.markDirty();
		else entry.pacer.publishNow();
	}

	/** Close and permanently erase a session's on-disk state. */
	async deleteSession(name: string): Promise<void> {
		const persistDir = this.hosted.get(name)?.persistDir ?? join(this.dataDir, name);
		try {
			await this.closeSession(name);
		} catch {
			/* not loaded: still erase any leftover directory */
		}
		this.meta.delete(name);
		await rm(persistDir, { recursive: true, force: true });
	}

	async closeSession(name: string): Promise<void> {
		const entry = this.hosted.get(name);
		if (entry === undefined) throw new Error(`no session ${name}`);
		entry.detach();
		await this.waitForIdle(entry, 2_000);
		try {
			await entry.agent.harness.close(BACKGROUND_CONTEXT);
		} catch {
			/* closing with an active operation aborts it; the journal already holds everything committed */
		}
		this.hosted.delete(name);
		entry.pacer.dispose();
		this.viewFingerprints.delete(name);
		if (this.attachPointerValue === name) this.attachPointerValue = this.hosted.keys().next().value ?? null;
	}

	private readonly meta = new Map<
		string,
		{ title?: string; pinned?: boolean; archived?: boolean; modelId?: string; personaId?: string }
	>();

	setMeta(
		name: string,
		patch: { pinned?: boolean; archived?: boolean; modelId?: string; title?: string; personaId?: string },
	): void {
		this.meta.set(name, { ...this.meta.get(name), ...patch });
		const persistDir = this.hosted.get(name)?.persistDir;
		if (persistDir !== undefined) {
			const merged = { ...(this.readMetaFile(persistDir) ?? {}), ...this.meta.get(name) };
			void writeFile(join(persistDir, "meta.json"), JSON.stringify(merged), "utf8").catch(() => undefined);
		}
	}

	/** Give an in-flight operation a grace window to settle before shutdown aborts it. */
	private async waitForIdle(entry: Hosted, budgetMs: number): Promise<void> {
		const deadline = Date.now() + budgetMs;
		while (Date.now() < deadline) {
			try {
				const execution = await entry.agent.lane.inspectExecution(BACKGROUND_CONTEXT);
				if (execution.current === null) return;
			} catch {
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 15));
		}
	}

	private readMetaFile(persistDir: string): SessionMetaFile | undefined {
		try {
			return JSON.parse(readFileSync(join(persistDir, "meta.json"), "utf8")) as SessionMetaFile;
		} catch {
			return undefined;
		}
	}

	private settingsFile: SettingsFile | undefined = undefined;

	/** Session defaults, read once from `<dataDir>/settings.json`; {} on first run. */
	settings(): SettingsFile {
		if (this.settingsFile === undefined) {
			try {
				this.settingsFile = JSON.parse(readFileSync(join(this.dataDir, "settings.json"), "utf8")) as SettingsFile;
			} catch {
				this.settingsFile = {};
			}
		}
		return this.settingsFile;
	}

	/** Merge a patch over the stored defaults, keep only known keys, persist, return all. */
	async saveSettings(patch: Record<string, unknown>): Promise<SettingsFile> {
		const next: SettingsFile = { ...this.settings() };
		for (const key of ["personaId", "modelId"] as const) {
			const value = patch[key];
			if (value === null) delete next[key];
			else if (typeof value === "string" && value.trim().length > 0) next[key] = value.trim();
		}
		if (typeof patch.thinkingLevel === "string") {
			const level = patch.thinkingLevel as ThinkingLevel;
			if (patch.thinkingLevel === null) delete next.thinkingLevel;
			else if (THINKING_LEVELS.includes(level)) next.thinkingLevel = level;
		} else if (patch.thinkingLevel === null) delete next.thinkingLevel;
		if (typeof patch.keepRecentTokens === "number") {
			if (Number.isSafeInteger(patch.keepRecentTokens) && patch.keepRecentTokens > 0)
				next.keepRecentTokens = patch.keepRecentTokens;
		} else if (patch.keepRecentTokens === null) delete next.keepRecentTokens;
		this.settingsFile = next;
		await mkdir(this.dataDir, { recursive: true });
		await writeFile(join(this.dataDir, "settings.json"), JSON.stringify(next), "utf8");
		return next;
	}

	private autoTitle(name: string): string | undefined {
		const stored = this.meta.get(name)?.title;
		if (stored !== undefined) return stored;
		for (const entry of this.hosted.get(name)?.view.messages ?? []) {
			const text = userText(entry.message);
			if (text.length >= 3) return text.slice(0, 60);
		}
		return undefined;
	}

	/** Substring search across hosted sessions' visible timelines. */
	search(query: string): { session: string; snippet: string }[] {
		const hits: { session: string; snippet: string }[] = [];
		const needle = query.toLowerCase();
		if (needle.length === 0) return hits;
		for (const [name, hosted] of this.hosted) {
			for (const entry of hosted.view.messages) {
				const text = JSON.stringify(entry.message).toLowerCase();
				const index = text.indexOf(needle);
				if (index >= 0) {
					hits.push({
						session: name,
						snippet: JSON.stringify(entry.message).slice(Math.max(0, index - 30), index + 60),
					});
					break;
				}
			}
		}
		return hits;
	}

	sidebar(): SidebarSession[] {
		return [...this.hosted.entries()].map(([name, entry]) => ({
			name,
			...(this.autoTitle(name) === undefined ? {} : { title: this.autoTitle(name) }),
			...(this.meta.get(name)?.pinned === true ? { pinned: true } : {}),
			...(this.meta.get(name)?.archived === true ? { archived: true } : {}),
			cwd: entry.cwd,
			updated: entry.updated,
			badges: [
				...(entry.running ? ["running"] : []),
				...(entry.view.goal?.status === "active" ? ["goal"] : []),
				...(entry.view.goal?.status === "achieved" ? ["goal-done"] : []),
				...(entry.view.pendingAsk === undefined ? [] : ["ask-pending"]),
				...(entry.view.loops.length > 0 ? ["loop"] : []),
			],
			personas: entry.view.personas,
		}));
	}

	names(): string[] {
		return [...this.hosted.keys()];
	}

	agentOf(name: string): EtaAgent | undefined {
		return this.hosted.get(name)?.agent;
	}

	/** Workspace entries the composer's @mention popup can complete to. */
	isRunning(name: string): boolean {
		return this.hosted.get(name)?.running ?? false;
	}

	cwdOf(name: string): string | undefined {
		return this.hosted.get(name)?.cwd;
	}

	filesOf(name: string): string[] {
		const entry = this.hosted.get(name);
		if (entry === undefined) return [];
		return listWorkspace(entry.cwd);
	}

	/** Read a workspace-relative text file for the timeline's file chips. */
	fileText(name: string, path: string): string | undefined {
		const entry = this.hosted.get(name);
		if (entry === undefined || path.length === 0 || path.startsWith("/") || path.includes("..")) return undefined;
		const full = `${entry.cwd}/${path}`;
		try {
			if (statSync(full).size > 200_000) return "[file too large to preview]";
			const root = realpathSync(entry.cwd);
			if (!realpathSync(full).startsWith(`${root}/`)) return undefined;
			return readFileSync(full, "utf8");
		} catch {
			return undefined;
		}
	}

	viewOf(name: string): SessionView | undefined {
		return this.hosted.get(name)?.view;
	}

	queueRemove(name: string, entryId: string): void {
		void this.must(name)
			.lane.cancelQueued(entryId, BACKGROUND_CONTEXT)
			.catch(() => undefined);
	}

	/** Lane queue items ride the view so the composer renders the real queue, not guesses. */
	/** Best-effort git branch of the session cwd; stamped into the header on success. */
	private refreshBranch(name: string): void {
		const entry = this.hosted.get(name);
		if (entry === undefined) return;
		try {
			const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
				cwd: entry.cwd,
				stdout: "pipe",
				stderr: "ignore",
			});
			void proc.exited.then(async (code) => {
				if (code !== 0) return;
				const branch = (await new Response(proc.stdout as ReadableStream).text()).trim();
				if (branch.length === 0 || branch.length > 60) return;
				const hosted = this.hosted.get(name);
				if (hosted === undefined) return;
				hosted.gitBranch = branch;
				this.refreshView(name);
			});
		} catch {
			/* git missing or cwd not a checkout */
		}
	}

	private stampView(entry: Hosted, view: SessionView = entry.view): SessionView {
		return {
			...view,
			cwd: entry.cwd,
			...(entry.gitBranch === undefined ? {} : { gitBranch: entry.gitBranch }),
			queue: entry.queue.map((item) => ({
				entryId: item.entryId,
				kind: item.kind,
				text:
					item.type === "message"
						? userText(item.message as unknown as { role: string; content?: unknown; text?: string })
						: String(item.customType),
			})),
		};
	}

	ringOf(name: string): DevRing | undefined {
		return this.hosted.get(name)?.ring;
	}

	askOf(name: string): { answer: AnswerFn; abort(questionId: string): boolean } | undefined {
		const entry = this.hosted.get(name);
		return entry === undefined
			? undefined
			: { answer: (id, response) => entry.agent.ask.answer(id, response), abort: (id) => entry.agent.ask.abort(id) };
	}

	goal(name: string, action: "set" | "pause" | "resume" | "clear", objective?: string): void {
		const agent = this.must(name);
		const entry = this.hosted.get(name);
		if (entry === undefined) return;
		if (action === "set" && objective !== undefined) agent.goal.set(objective);
		if (action === "pause") agent.goal.pause();
		if (action === "resume") agent.goal.resume();
		if (action === "clear") agent.goal.clear();
		entry.view = this.stampView(entry);
		this.publishView(name);
		// Setting a goal means "go work on it": kick a run when the lane is idle.
		if (action === "set" && objective !== undefined && !entry.running) {
			void this.prompt(name, `Work toward the goal: ${objective}`).catch(() => undefined);
		}
	}

	loopCreate(name: string, id: string, note: string, every?: string): void {
		const entry = this.hosted.get(name);
		if (entry === undefined) return;
		entry.agent.loops.upsert({
			def: { id, note, ...(every === undefined || every.length === 0 ? {} : { every }) },
			runCount: 0,
			createdAt: Date.now(),
			paused: false,
		});
		entry.view = this.stampView(entry);
		this.publishView(name);
	}

	loopToggle(name: string, id: string, paused: boolean): void {
		this.must(name).loops.pause(id, paused);
		this.refreshView(name);
	}

	loopRemove(name: string, id: string): void {
		const agent = this.must(name);
		agent.loops.remove(id);
		void agent.lane
			.publish([{ type: "eta", category: "loop", action: "remove", data: { loopId: id } }], BACKGROUND_CONTEXT)
			.catch(() => undefined);
		this.refreshView(name);
	}

	memoryText(name: string): Promise<{ text: string; files: string[] }> | undefined {
		const loader = this.hosted.get(name)?.created.memory;
		return loader === undefined ? undefined : loader();
	}

	taskSet(name: string, id: string, status: "pending" | "in_progress" | "completed" | "cancelled"): void {
		this.must(name).setTask(id, { status });
		this.refreshView(name);
	}

	taskCreate(name: string, content: string, priority?: "high" | "medium" | "low"): void {
		this.must(name).tasks.create(content, priority === undefined ? {} : { priority });
		this.refreshView(name);
	}

	taskUpdate(name: string, id: string, patch: { content?: string; priority?: "high" | "medium" | "low" }): void {
		this.must(name).setTask(id, patch);
		this.refreshView(name);
	}

	taskRemove(name: string, id: string): void {
		const agent = this.must(name);
		agent.tasks.remove(id);
		void agent.lane
			.publish([{ type: "eta", category: "task", action: "remove", data: { taskId: id } }], BACKGROUND_CONTEXT)
			.catch(() => undefined);
		this.refreshView(name);
	}

	private refreshView(name: string): void {
		const entry = this.hosted.get(name);
		if (entry === undefined) return;
		entry.updated = Date.now();
		entry.view = this.stampView(entry);
		this.publishView(name);
	}

	stateSet(name: string, key: string, value: string | null): void {
		const agent = this.must(name);
		void agent.stateKv.set(key, value);
		void agent.lane
			.publish(
				[{ type: "eta", category: "state", action: value === null ? "delete" : "set", data: { key } }],
				BACKGROUND_CONTEXT,
			)
			.catch(() => undefined);
	}

	subagentStop(name: string, id: string): void {
		this.must(name).subagents.stop(id, undefined);
	}

	async btwOpen(name: string, kind: "contextual" | "tangent"): Promise<void> {
		const agent = this.must(name);
		const thread = agent.btw.create(kind);
		if (kind === "contextual") {
			agent.btw.seedFrom(thread.id, await agent.lane.findEntries(undefined, BACKGROUND_CONTEXT), null);
		}
	}

	btwAnswer(name: string, threadId: string, question: string, answer: string): void {
		this.must(name).btw.answer(threadId, question, answer);
	}

	/** Side-thread question from the UI; the faux provider answers with an echo, real providers answer later. */
	btwAsk(name: string, threadId: string, question: string): void {
		const agent = this.must(name);
		const faux = this.hosted.get(name)?.created.faux;
		const answer = faux !== undefined ? `btw echo: ${question}` : "(awaiting model)";
		agent.btw.answer(threadId, question, answer);
	}

	/** Hot-swap the configured model (real providers only) and remember the choice. */
	/** Swap a live session's persona and persist the choice in meta.json. */
	async personaSet(name: string, personaId: string): Promise<void> {
		const entry = this.hosted.get(name);
		if (entry === undefined) return;
		const persona = await renderPersonaFor(entry.cwd, personaId);
		if (persona === undefined) return;
		entry.agent.applyPersona(persona);
		this.setMeta(name, { personaId });
		entry.updated = Date.now();
		entry.view = this.stampView(entry, await entry.projector.snapshot(BACKGROUND_CONTEXT));
		this.publishView(name);
	}

	async thinkingLevel(name: string, level: "off" | "minimal" | "low" | "medium" | "high"): Promise<void> {
		await this.must(name).lane.setThinkingLevel(level, BACKGROUND_CONTEXT);
		this.refreshView(name);
		void this.hosted
			.get(name)
			?.projector.snapshot(BACKGROUND_CONTEXT)
			.then((view) => {
				const hosted = this.hosted.get(name);
				if (hosted === undefined) return;
				hosted.view = this.stampView(hosted, view);
				this.publishView(name);
			});
	}

	async modelSet(name: string, modelId: string): Promise<void> {
		const agent = this.must(name);
		this.setMeta(name, { modelId });
		if (this.hosted.get(name)?.created.faux === undefined) {
			const split = modelId.indexOf(":");
			const identity =
				split > 0
					? { provider: modelId.slice(0, split), modelId: modelId.slice(split + 1) }
					: { provider: "anthropic", modelId };
			try {
				await agent.lane.setModel(identity, BACKGROUND_CONTEXT);
			} catch {
				/* unknown id for this registry: keep the meta so it applies on next open */
			}
		}
	}

	/** Model catalog with no session context (welcome screen picker). */
	modelCatalog(): { models: { id: string; label: string; contextWindow: number }[]; current: string } {
		return this.modelCatalogFrom(this.etaConfig(), false);
	}

	modelInfo(name: string): { models: { id: string; label: string; contextWindow: number }[]; current: string } {
		const faux = this.hosted.get(name)?.created.faux;
		return this.modelCatalogFrom(this.etaConfig(), faux !== undefined, this.meta.get(name)?.modelId);
	}

	private modelCatalogFrom(
		cfg: EtaConfig,
		faux: boolean,
		currentOverride?: string,
	): { models: { id: string; label: string; contextWindow: number }[]; current: string } {
		const configured = (cfg.providers ?? []).flatMap((provider) =>
			provider.models.map((model) => ({
				id: `${provider.id}:${model.id}`,
				label: model.name ?? model.id,
				contextWindow: model.contextWindow ?? 128_000,
			})),
		);
		const fallback = configDefaultModel(cfg);
		const current =
			currentOverride ??
			(configured.length > 0
				? fallback !== undefined
					? `${fallback.provider}:${fallback.modelId}`
					: configured[0]!.id
				: undefined) ??
			(faux ? "faux" : "claude-sonnet-4-5");
		if (configured.length > 0) return { models: configured, current };
		if (faux) return { models: [{ id: "faux", label: "faux echo", contextWindow: 128_000 }], current };
		return {
			models: ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-1"].map((id) => ({
				id: `anthropic:${id}`,
				label: id,
				contextWindow: 200_000,
			})),
			current,
		};
	}

	btwSave(name: string, threadId: string): void {
		this.must(name).btw.save(threadId, false);
	}

	btwClear(name: string, threadId: string): void {
		this.must(name).btw.clear(threadId);
	}

	async compact(name: string): Promise<void> {
		await this.must(name).lane.compact(undefined, BACKGROUND_CONTEXT);
	}

	async abort(name: string): Promise<void> {
		await this.must(name).lane.abort(BACKGROUND_CONTEXT);
	}

	private must(name: string): EtaAgent {
		const entry = this.hosted.get(name);
		if (entry === undefined) throw new Error(`no session ${name}`);
		return entry.agent;
	}

	/** Composer send: steer mid-run, follow-up while running, plain prompt otherwise. */
	queue(name: string, text: string, mode: "queue" | "steer"): void {
		const entry = this.hosted.get(name);
		if (entry === undefined) return;
		this.attachPointerValue = name;
		const lane = entry.agent.lane;
		void (entry.running && mode === "steer"
			? lane.steer(text, undefined, BACKGROUND_CONTEXT)
			: entry.running
				? lane.followUp(text, undefined, BACKGROUND_CONTEXT)
				: lane.prompt(text, undefined, BACKGROUND_CONTEXT));
	}

	async prompt(name: string, text: string): Promise<void> {
		const entry = this.hosted.get(name);
		if (entry === undefined) throw new Error(`no session ${name}`);
		this.attachPointerValue = name;
		await entry.agent.lane.prompt(text, undefined, BACKGROUND_CONTEXT);
	}

	/**
	 * Channel subscribers. `payload` is the wire string for view frames — encoded
	 * once for every socket, so a fan-out does not re-serialize a megabyte per tab.
	 */
	subscribe(listener: (frame: ChannelFrame, payload?: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async close(): Promise<void> {
		for (const entry of this.hosted.values()) {
			entry.detach();
			await entry.agent.harness.close(BACKGROUND_CONTEXT);
		}
		this.hosted.clear();
	}

	private emit(frame: ChannelFrame, payload?: string): void {
		for (const listener of [...this.listeners]) listener(frame, payload);
	}
}

export function listWorkspace(cwd: string): string[] {
	try {
		return readdirSync(cwd)
			.filter((name) => !name.startsWith(".") && name !== "node_modules")
			.slice(0, 24);
	} catch {
		return [];
	}
}
