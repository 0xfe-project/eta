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
	parseEvery,
	EtaAgent,
	type MemoryLoaded,
	SessionViewProjector,
	type HarnessEvent,
	type LaneQueuedItem,
	type SessionView,
	type SessionViewMessage,
	type ThinkingLevel,
} from "@eta/core";
import {
	DevRing,
	encodeMessage,
	viewFingerprint,
	viewPatch,
	type ChannelFrame,
	type DevFrame,
	type ServerMessage,
	type SidebarSession,
} from "./protocol.ts";
import { ViewPacer } from "./view-pacer.ts";
import { configDefaultModel, etaConfigPath, loadEtaConfig, type EtaConfig } from "./config.ts";
import { createSessionAgent, type CreatedSession } from "./agent.ts";
import { renderPersonaFor, resolvePersonaId } from "./personas.ts";
import { ProviderConfigStore, ProviderConfigError } from "./providers.ts";
import { effectiveModel, modelDefaultThinking, modelThinkingLevels, type EtaModelConfig, type ProvidersView } from "@eta/core/provider-config";

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
	pendingModels?: EtaConfig;
	detach(): void;
}

export interface HostOptions {
	/** Override the ~/.eta/config.json location (tests run offline with this). */
	configPath?: string;
	/** Where per-session journals and meta.json live; defaults to ~/.eta/sessions. */
	dataDir?: string;
	/**
	 * Loop heartbeat cadence in ms. A session with no loops holds no timer at all, so the
	 * only cost of the default is one wake check per cadence in a session that has
	 * something scheduled; tests shorten it to make a fired loop observable.
	 */
	heartbeatMs?: number;
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
	/**
	 * Folder new sessions start in. Without it a session with no folder falls back to
	 * the server's own launch directory, which in the desktop shell is wherever the app
	 * was started from — a folder nobody chose, and the one thing a person cannot tell
	 * they were given until the memory and the git status look wrong.
	 */
	cwd?: string;
}

interface SessionMetaFile {
	personaId?: string;
	cwd?: string;
	modelId?: string;
	keepRecentTokens?: number;
	title?: string;
	pinned?: boolean;
	archived?: boolean;
	createdAt?: number;
}

export class Host {
	readonly configPath: string;
	readonly dataDir: string;
	readonly heartbeatMs: number | undefined;
	private readonly hosted = new Map<string, Hosted>();
	readonly providers: ProviderConfigStore;

	constructor(options: HostOptions = {}) {
		this.configPath = options.configPath ?? etaConfigPath;
		this.dataDir = options.dataDir ?? join(homedir(), ".eta", "sessions");
		this.heartbeatMs = options.heartbeatMs;
		this.providers = new ProviderConfigStore(this.configPath);
	}

	private etaConfig(): EtaConfig {
		return loadEtaConfig(this.configPath) ?? {};
	}
	private readonly listeners = new Set<(frame: ServerMessage, payload?: string) => void>();
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
		modelId ??= this.etaConfig().defaultModel ?? this.settings().modelId;
		const persistDir = join(this.dataDir, name);
		await mkdir(persistDir, { recursive: true });
		await writeFile(
			join(persistDir, "meta.json"),
			JSON.stringify({ personaId, cwd, ...(modelId === undefined ? {} : { modelId }), keepRecentTokens: this.settings().keepRecentTokens, createdAt: Date.now() }),
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
					keepRecentTokens: this.settings().keepRecentTokens,
					...(this.heartbeatMs === undefined ? {} : { heartbeatMs: this.heartbeatMs }),
				}),
			{ cwd, persistDir },
		);
		const entry = this.hosted.get(name)!;
		const chosen = await entry.agent.lane.getModel(BACKGROUND_CONTEXT);
		const definition = chosen ? this.configuredModel(`${chosen.provider}:${chosen.id}`) : undefined;
		if (definition) await entry.agent.lane.setThinkingLevel(modelDefaultThinking(definition), BACKGROUND_CONTEXT);
		else if (this.settings().thinkingLevel) await entry.agent.lane.setThinkingLevel(this.settings().thinkingLevel!, BACKGROUND_CONTEXT);
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
			// A missing card is not a reason to lose a chat: the session reopens under the
			// closest card it still has, and the warn below says which one that was.
			const persona = await resolvePersonaId(cwd, meta.personaId!);
			if (!persona.exact)
				console.warn(
					`[eta-host] session ${dir}: persona ${meta.personaId} is not a card any more, reopening it as ${persona.id}`,
				);
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
							personaId: persona.id,
							cwd,
							...(meta.modelId === undefined ? {} : { modelId: meta.modelId }),
							configPath: this.configPath,
							persistDir,
							keepRecentTokens: meta.keepRecentTokens,
							...(this.heartbeatMs === undefined ? {} : { heartbeatMs: this.heartbeatMs }),
						}),
					{ cwd, persistDir, restore: true },
				);
			} catch (error) {
				// A session that will not reopen must not take the server down, and it must not
				// vanish without a trace either: from the sidebar it would look like the chat
				// was deleted, when the journal on disk is what could not be read.
				console.warn(
					`[eta-host] session ${dir} did not reopen: ${error instanceof Error ? error.message : String(error)}`,
				);
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
					if (entry.pendingModels) {
						entry.created.reloadModels?.(entry.pendingModels);
						entry.pendingModels = undefined;
					}
					// Notes the user saved while the run was busy land here, at the boundary,
					// so a side answer never lands in the middle of someone's turn.
					void agent.btw.flushQueued().then((flushed) => {
						if (flushed > 0) this.refreshView(name);
					});
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
			// A loop came due while no run could take its followUp, and the scheduler said so
			// on the bus as `wake`. Starting the run is the host's call, not the scheduler's:
			// this is where the answer to "is one already in flight" lives.
			// The btw panel reads threads out of the view, so a side request's progress —
			// asking, answered, failed, saved — is only visible once the view is rebuilt.
			if (frame.category === "btw") this.refreshView(name);
			if (frame.category === "loop" && frame.action === "wake")
				this.deliver((frame.data as { followUp?: string }).followUp ?? "", name, false);
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
				// A patch is safe while every tab can fold one and the transcript is the
				// one the sockets were last handed; the version is the frame's identity,
				// what a client tracks to notice it fell behind and must resync.
				const unchanged = this.viewSync.patchSafe(name, view);
				const version = this.viewSync.version(name);
				pending = unchanged
					? { channel: "view", session: name, version, patch: viewPatch(view) }
					: { channel: "view", session: name, version, view };
				return encodeMessage(pending);
			},
			deliver: (payload) => {
				if (pending !== undefined) this.emit(pending, payload);
			},
		});
	}

	/**
	 * The view channel's sync state machine — which transcript each socket is
	 * assumed to hold, how far each session's content generation has moved, and
	 * whether patch frames are on the table at all. See ViewSync.
	 */
	private readonly viewSync = new ViewSync();

	/** The version of the newest published view of a session; 0 before any. */
	viewVersion(name: string): number {
		return this.viewSync.version(name);
	}

	/** True while every connected tab can fold a patch frame; set by the negotiation in server.ts. */
	setPatchCapable(on: boolean): void {
		this.viewSync.setCapable(on);
	}

	/** Note that `view` was just sent to someone in full, so patches may follow it. */
	rememberView(name: string, view: SessionView): void {
		this.viewSync.record(name, view);
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
		this.viewSync.bump(name);
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
		this.viewSync.forget(name);
		this.reprojectSeq.delete(name);
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
		for (const key of ["personaId", "modelId", "cwd"] as const) {
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

	/** Older transcript rows for pagination: the messages just before `beforeSeq`, oldest first. */
	async historyOf(name: string, beforeSeq: number, limit: number): Promise<SessionViewMessage[] | undefined> {
		const agent = this.hosted.get(name)?.agent;
		if (agent === undefined) return undefined;
		const entries = await agent.lane.findEntries(
			{ order: "newestFirst", type: "message", cursor: { seq: beforeSeq }, limit },
			BACKGROUND_CONTEXT,
		);
		const messages: SessionViewMessage[] = [];
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			messages.push({ entryId: entry.id, seq: entry.seq, at: entry.timestamp, message: entry.message });
		}
		return messages.reverse();
	}

	viewOf(name: string): SessionView | undefined {
		return this.hosted.get(name)?.view;
	}

	queueRemove(name: string, entryId: string): void {
		// The outcome is the reason this call answers at all: the chip vanishes either
		// way, and the composer only takes the text back (or re-injects it as a steer)
		// when the cancel actually beat the run to it.
		void this.must(name)
			.lane.cancelQueued(entryId, BACKGROUND_CONTEXT)
			.then((result) => {
				if (result.ok) this.emit({ type: "queueAck", session: name, entryId, outcome: result.value.kind });
			}, () => undefined);
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
		const definition = view?.model ? this.configuredModel(view.model) : undefined;
		return {
			...view,
			supportedThinkingLevels: definition ? modelThinkingLevels(definition) : undefined,
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
		// Setting a goal means "go work on it": kick a run when the lane is idle.
		if (action === "set" && objective !== undefined && !entry.running) {
			void this.prompt(name, `Work toward the goal: ${objective}`).catch(() => undefined);
		}
		this.refreshView(name);
	}

	loopCreate(name: string, id: string, note: string, every?: string, cron?: string): void {
		const agent = this.must(name);
		const interval = every?.trim() ?? "";
		const schedule = cron?.trim() ?? "";
		// The check the model's own LoopCreate has always made. A spec with no trigger is
		// never due: pump has no interval to read and the event matcher has nothing to
		// match, so it would sit in the panel, looking created, for its whole 7-day TTL.
		if (interval.length === 0 && schedule.length === 0)
			throw new Error(`loop ${id}: needs an interval ('45s', '5m', '2h') or a cron schedule`);
		// A bad interval is the caller's mistake, not a state change: let it throw, so the
		// op comes back as an error frame instead of a loop that silently never fires.
		if (interval.length > 0) parseEvery(interval);
		agent.loops.upsert({
			def: {
				id,
				note,
				...(interval.length === 0 ? {} : { every: interval }),
				...(schedule.length === 0 ? {} : { cron: schedule }),
			},
			runCount: 0,
			createdAt: Date.now(),
			paused: false,
		});
		this.refreshView(name);
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

	memoryText(name: string): Promise<MemoryLoaded> | undefined {
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
		// The batteries — goal, tasks, loops — live outside the journal, so the view from
		// the last projection does not know what the op that just arrived did to them.
		// Re-project instead of re-stamping the copy: a frame that presents itself as the
		// current state has to have been read after the change, or the panel only catches
		// up the next time the journal happens to move.
		void this.reproject(name);
	}

	/**
	 * Projection requests in flight, per session: only the newest one may publish.
	 *
	 * Re-projecting the whole journal on every op looked like the wrong trade until it was
	 * measured: a snapshot of a 2400-entry journal is 0.35ms, and a 200-entry one is 0.17ms
	 * — the scan is linear at ~0.15µs an entry, and the view's transcript is windowed, so it
	 * does not grow with the journal either. Against the 100ms floor a frame already buys
	 * (see the view-frame budget above), an op paying for its own truth is free.
	 */
	private readonly reprojectSeq = new Map<string, number>();

	/** Project now, publish what comes back, and drop it if a newer request overtook it. */
	private async reproject(name: string): Promise<void> {
		const entry = this.hosted.get(name);
		if (entry === undefined) return;
		const seq = (this.reprojectSeq.get(name) ?? 0) + 1;
		this.reprojectSeq.set(name, seq);
		let view: SessionView;
		try {
			view = await entry.projector.snapshot(BACKGROUND_CONTEXT);
		} catch {
			return;
		}
		const hosted = this.hosted.get(name);
		if (hosted === undefined || this.reprojectSeq.get(name) !== seq) return;
		hosted.view = this.stampView(hosted, view);
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
		const thread = this.must(name).btw.create(kind);
		await this.reseedBtw(name, thread.id);
		this.refreshView(name);
	}

	/**
	 * Take the thread's seed from the session as it is now: everything visible
	 * except the side chatter itself, so side answers never compound.
	 */
	private async reseedBtw(name: string, threadId: string): Promise<void> {
		const agent = this.must(name);
		agent.btw.seedFrom(threadId, await agent.lane.findEntries(undefined, BACKGROUND_CONTEXT), null);
	}

	/**
	 * Ask a thread. The wait belongs to the thread (`pending`), and the frame showing
	 * it goes out before the answer does: a side request that takes seconds must not
	 * look frozen. `ask` settles into an answer or an error and never rejects.
	 */
	async btwAsk(name: string, threadId: string, question: string): Promise<void> {
		const agent = this.must(name);
		const settled = agent.btw.ask(threadId, question);
		this.refreshView(name);
		await settled;
		this.refreshView(name);
	}

	btwAnswer(name: string, threadId: string, question: string, answer: string): void {
		this.must(name).btw.answer(threadId, question, answer);
		this.refreshView(name);
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

	async thinkingLevel(name: string, level: ThinkingLevel): Promise<void> {
		if (!THINKING_LEVELS.includes(level)) throw new ProviderConfigError("invalid_effort");
		const agent = this.must(name);
		const current = await agent.lane.getModel(BACKGROUND_CONTEXT);
		const definition = current ? this.configuredModel(`${current.provider}:${current.id}`) : undefined;
		if (definition && !modelThinkingLevels(definition).includes(level)) throw new ProviderConfigError("invalid_effort");
		await agent.lane.setThinkingLevel(level, BACKGROUND_CONTEXT);
		this.refreshView(name);
	}

	async modelSet(name: string, modelId: string): Promise<void> {
		const entry = this.hosted.get(name);
		if (!entry) throw new Error(`no session ${name}`);
		if (entry.running) throw new ProviderConfigError("session_busy", 409);
		entry.created.reloadModels?.(this.etaConfig());
		const split = modelId.indexOf(":");
		const identity = split > 0 ? { provider: modelId.slice(0, split), modelId: modelId.slice(split + 1) } : { provider: "anthropic", modelId };
		if (entry.created.models && !entry.created.models.getModel(identity.provider, identity.modelId)) throw new ProviderConfigError("model_unavailable", 400);
		await entry.agent.lane.setModel(identity, BACKGROUND_CONTEXT);
		const definition = this.configuredModel(modelId);
		if (definition) await entry.agent.lane.setThinkingLevel(modelDefaultThinking(definition), BACKGROUND_CONTEXT);
		this.setMeta(name, { modelId });
		this.refreshView(name);
	}

	private configuredModel(id: string): EtaModelConfig | undefined {
		for (const provider of this.etaConfig().providers ?? []) {
			const model = provider.models.find(model => `${provider.id}:${model.id}` === id);
			if (model) return effectiveModel(model);
		}
		return undefined;
	}

	async providerView(): Promise<ProvidersView> {
		const view = await this.providers.view();
		return { ...view, defaultModel: view.defaultModel ?? this.settings().modelId };
	}

	async saveProvider(body: unknown): Promise<ProvidersView> {
		const candidate = (body as { provider?: { id?: string; models?: { id?: string }[] } })?.provider;
		if (candidate?.id && Array.isArray(candidate.models)) await this.assertModelsNotInUse(candidate.id, candidate.models.map(model => model.id ?? ""));
		const view = await this.providers.save(body);
		this.providersChanged();
		return view;
	}

	async deleteProvider(id: string, revision: unknown): Promise<ProvidersView> {
		await this.assertModelsNotInUse(id, []);
		const view = await this.providers.delete(id, revision);
		if (this.settings().modelId?.startsWith(`${id}:`)) {
			await this.saveSettings({ modelId: null, thinkingLevel: null });
		}
		this.providersChanged();
		return view;
	}

	async defaultProviderModel(body: unknown): Promise<ProvidersView> {
		const view = await this.providers.setDefault(body);
		// The provider config is now the sole default-model editor. Clearing an old
		// session default keeps "follow configuration" from resurrecting it later.
		await this.saveSettings({ modelId: null, thinkingLevel: null });
		this.providersChanged();
		return view;
	}

	private async assertModelsNotInUse(providerId: string, remaining: string[]): Promise<void> {
		for (const entry of this.hosted.values()) {
			const current = await entry.agent.lane.getModel(BACKGROUND_CONTEXT);
			if (current?.provider === providerId && !remaining.includes(current.id)) throw new ProviderConfigError("provider_in_use", 409);
		}
	}

	private providersChanged(): void {
		const config = this.etaConfig();
		for (const [name, entry] of this.hosted) {
			if (entry.running) entry.pendingModels = config;
			else { entry.created.reloadModels?.(config); this.refreshView(name); }
		}
		this.emit({ type: "models_changed" });
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
			provider.models.map(effectiveModel).map((model) => ({
				id: `${provider.id}:${model.id}`,
				label: model.name ?? model.id,
				contextWindow: model.contextWindow ?? 128_000,
				thinkingLevels: modelThinkingLevels(model),
				defaultThinking: modelDefaultThinking(model),
			})),
		);
		const fallback = configDefaultModel(cfg);
		const current =
			currentOverride ?? cfg.defaultModel ?? this.settings().modelId ??
			(configured.length > 0
				? fallback !== undefined
					? `${fallback.provider}:${fallback.modelId}`
					: configured[0]!.id
				: undefined) ??
			(faux ? "faux" : "claude-sonnet-4-5");
		if (configured.length > 0) return { models: configured, current };
		if (faux) return { models: [{ id: "faux", label: "faux echo", contextWindow: 128_000 }], current };
		if (!process.env.ANTHROPIC_API_KEY) return { models: [], current: currentOverride ?? "" };
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
		// Saving mid-run queues the note; flushQueued writes it at the boundary.
		this.must(name).btw.save(threadId, this.hosted.get(name)?.running ?? false);
		this.refreshView(name);
	}

	/**
	 * Hand a thread's results to the main run — the same driver goals and loops
	 * use (a followUp), so the main agent folds them in at its next boundary.
	 * With nothing running a followUp would sit unread, so a run is kicked
	 * instead; that is what setting a goal does for the same reason.
	 */
	btwHandoff(name: string, threadId: string): void {
		const agent = this.must(name);
		const text = agent.btw.handoff(threadId);
		if (text === undefined) return;
		this.deliver(text, name, true);
		this.refreshView(name);
	}

	/**
	 * Hand text to a session in the one shape that cannot be lost: a followUp while a run
	 * is in flight to fold it in, a run of its own when the lane is idle, because a
	 * followUp with nothing running would sit unread. `focus` moves the attach pointer —
	 * someone who handed off a thread should arrive at the session; a loop that came due
	 * in the background should not steal the view they were looking at.
	 */
	private deliver(text: string, name: string, focus: boolean): void {
		const entry = this.hosted.get(name);
		if (entry === undefined || text.length === 0) return;
		if (entry.running) {
			void entry.agent.lane.followUp(text, undefined, BACKGROUND_CONTEXT).catch(() => undefined);
			return;
		}
		if (focus) void this.prompt(name, text).catch(() => undefined);
		else void entry.agent.lane.prompt(text, undefined, BACKGROUND_CONTEXT).catch(() => undefined);
	}

	btwClear(name: string, threadId: string): void {
		this.must(name).btw.clear(threadId);
		this.refreshView(name);
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
	subscribe(listener: (frame: ServerMessage, payload?: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async close(): Promise<void> {
		this.providers.codexLogin.cancel();
		for (const entry of this.hosted.values()) {
			entry.detach();
			await entry.agent.harness.close(BACKGROUND_CONTEXT);
		}
		this.hosted.clear();
	}

	private emit(frame: ServerMessage, payload?: string): void {
		for (const listener of [...this.listeners]) listener(frame, payload);
	}
}

/**
 * The view channel's sync state, folded into one place: the transcript each
 * socket is assumed to hold (so a frame may leave it out), the monotonic content
 * generation (so a client notices it fell behind and resyncs), and the
 * patch-capable flag negotiated with the sockets.
 */
class ViewSync {
	/** Transcript signature last sent whole, per session — what a patch may omit. */
	private readonly fingerprints = new Map<string, string>();
	/** Monotonic content generation, bumped on every published change. */
	private readonly versions = new Map<string, number>();
	/** True while every connected tab can fold a patch frame. */
	private capable = false;

	version(name: string): number {
		return this.versions.get(name) ?? 0;
	}

	/** Register a content change: the next published frame is a new generation. */
	bump(name: string): void {
		this.versions.set(name, this.version(name) + 1);
	}

	/**
	 * Whether a frame for `name` may leave the transcript out — every tab must be
	 * able to fold a patch, and the transcript must be the one the sockets were
	 * last handed. Records the fingerprint either way.
	 */
	patchSafe(name: string, view: SessionView): boolean {
		const next = viewFingerprint(view);
		const unchanged = this.capable && this.fingerprints.get(name) === next;
		this.fingerprints.set(name, next);
		return unchanged;
	}

	/** Note that a whole view was just handed to a socket, so patches may follow it. */
	record(name: string, view: SessionView): void {
		this.fingerprints.set(name, viewFingerprint(view));
	}

	setCapable(on: boolean): void {
		if (this.capable === on) return;
		this.capable = on;
		// Flipping off invalidates the assumption that every socket holds the last
		// transcript: the next frame must be a whole one. Flipping on needs no
		// reset — while off, every frame carried the whole view anyway.
		if (!on) this.fingerprints.clear();
	}

	forget(name: string): void {
		this.fingerprints.delete(name);
		this.versions.delete(name);
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
