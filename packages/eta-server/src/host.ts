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
import { BACKGROUND_CONTEXT, EtaAgent, SessionViewProjector, type HarnessEvent, type LaneQueuedItem, type SessionView } from "@eta/core";
import { DevRing, type ChannelFrame, type DevFrame, type SidebarSession } from "./protocol.ts";
import { configDefaultModel, etaConfigPath, loadEtaConfig, type EtaConfig } from "./config.ts";
import { createSessionAgent, type CreatedSession } from "./agent.ts";

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
	running: boolean;
	queue: LaneQueuedItem[];
	cwd: string;
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
	private readonly listeners = new Set<(frame: ChannelFrame) => void>();
	private attachPointerValue: string | null = null;

	get attachPointer(): string | null {
		return this.attachPointerValue;
	}

	focus(name: string): void {
		this.attachPointerValue = name;
	}

	async createSession(name: string, personaId: string, cwd: string, modelId?: string): Promise<void> {
		if (this.hosted.has(name)) throw new Error(`session exists: ${name}`);
		const persistDir = join(this.dataDir, name);
		await mkdir(persistDir, { recursive: true });
		await writeFile(join(persistDir, "meta.json"), JSON.stringify({ personaId, cwd, ...(modelId === undefined ? {} : { modelId }), createdAt: Date.now() }), "utf8");
		await this.open(name, () => createSessionAgent({ name, personaId, cwd, ...(modelId === undefined ? {} : { modelId }), configPath: this.configPath, persistDir }), { cwd, persistDir });
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
			this.meta.set(dir, { ...(meta.title === undefined ? {} : { title: meta.title }), ...(meta.pinned === true ? { pinned: true } : {}), ...(meta.archived === true ? { archived: true } : {}), ...(meta.modelId === undefined ? {} : { modelId: meta.modelId }) });
			try {
				await this.open(dir, () => createSessionAgent({ name: dir, personaId: meta.personaId!, cwd, ...(meta.modelId === undefined ? {} : { modelId: meta.modelId }), configPath: this.configPath, persistDir }), { cwd, persistDir, restore: true });
			} catch {
				/* a broken journal must not take the whole server down */
			}
		}
	}

	async open(name: string, create: () => Promise<CreatedSession>, options: { restore?: boolean; cwd?: string; persistDir?: string } = {}): Promise<void> {
		const made = await create();
		const agent = made.agent;
		if (options.restore === true) await agent.restore(BACKGROUND_CONTEXT);
		await agent.refreshPromptBlocks();
		const projector = new SessionViewProjector(agent);
		const ring = new DevRing();
		if (options.persistDir !== undefined) {
			try {
				const lines = (await readFile(join(options.persistDir, "dev.jsonl"), "utf8")).split("\n").filter((line) => line.length > 0);
				ring.seed(lines.slice(-512).map((line) => JSON.parse(line) as DevFrame));
			} catch {
				/* first boot for this session */
			}
		}
		const entry: Hosted = {
			agent,
			projector,
			ring,
			view: this.stampView({ agent, projector, ring, view: null as unknown as SessionView, running: false, queue: [], cwd: options.cwd ?? process.cwd(), persistDir: options.persistDir, created: made, detach: () => {} }),
			running: false,
			queue: [],
			cwd: options.cwd ?? process.cwd(),
			persistDir: options.persistDir,
			created: made,
			detach: () => {},
		};
		this.hosted.set(name, entry);
		entry.view = this.stampView(entry, await projector.snapshot(BACKGROUND_CONTEXT));
		for (const type of AGENT_EVENT_TYPES) {
			agent.harness.events.on(type, (event: HarnessEvent) => {
				if (type === "run_start") entry.running = true;
				if (type === "run_end") entry.running = false;
				if (type === "queue_update") {
					entry.queue = (event as { queues: LaneQueuedItem[] }).queues;
					entry.view = this.stampView(entry);
					this.emit({ channel: "view", session: name, view: entry.view });
				}
				this.emit({ channel: "agent", session: name, event });
			});
		}
		agent.events.on("eta", (event) => {
			const frame: DevFrame = { ts: Date.now(), session: name, category: event.category, action: event.action, data: event.data };
			entry.ring.push(frame);
			this.emit({ channel: "dev", frame });
			if (entry.persistDir !== undefined) void appendFile(join(entry.persistDir, "dev.jsonl"), `${JSON.stringify(frame)}\n`, "utf8").catch(() => undefined);
		});
		const attached = await projector.attach((view) => {
			entry.view = this.stampView(entry, view);
			this.emit({ channel: "view", session: name, view });
		}, BACKGROUND_CONTEXT);
		entry.detach = attached.detach;
		this.attachPointerValue ??= name;
		this.emit({ channel: "view", session: name, view: entry.view });
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
		if (this.attachPointerValue === name) this.attachPointerValue = this.hosted.keys().next().value ?? null;
	}

	private readonly meta = new Map<string, { title?: string; pinned?: boolean; archived?: boolean; modelId?: string }>();

	setMeta(name: string, patch: { pinned?: boolean; archived?: boolean; modelId?: string; title?: string }): void {
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
					hits.push({ session: name, snippet: JSON.stringify(entry.message).slice(Math.max(0, index - 30), index + 60) });
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
		void this.must(name).lane.cancelQueued(entryId, BACKGROUND_CONTEXT).catch(() => undefined);
	}

	/** Lane queue items ride the view so the composer renders the real queue, not guesses. */
	private stampView(entry: Hosted, view: SessionView = entry.view): SessionView {
		return {
			...view,
			cwd: entry.cwd,
			queue: entry.queue.map((item) => ({
				entryId: item.entryId,
				kind: item.kind,
				text: item.type === "message" ? userText(item.message as unknown as { role: string; content?: unknown; text?: string }) : String(item.customType),
			})),
		};
	}

	ringOf(name: string): DevRing | undefined {
		return this.hosted.get(name)?.ring;
	}

	askOf(name: string): { answer: AnswerFn } | undefined {
		const entry = this.hosted.get(name);
		return entry === undefined ? undefined : { answer: (id, response) => entry.agent.ask.answer(id, response) };
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
		this.emit({ channel: "view", session: name, view: entry.view });
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
		this.emit({ channel: "view", session: name, view: entry.view });
	}

	loopToggle(name: string, id: string, paused: boolean): void {
		this.must(name).loops.pause(id, paused);
		this.refreshView(name);
	}

	loopRemove(name: string, id: string): void {
		const agent = this.must(name);
		agent.loops.remove(id);
		void agent.lane.publish([{ type: "eta", category: "loop", action: "remove", data: { loopId: id } }], BACKGROUND_CONTEXT).catch(() => undefined);
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
		void agent.lane.publish([{ type: "eta", category: "task", action: "remove", data: { taskId: id } }], BACKGROUND_CONTEXT).catch(() => undefined);
		this.refreshView(name);
	}

	private refreshView(name: string): void {
		const entry = this.hosted.get(name);
		if (entry === undefined) return;
		entry.view = this.stampView(entry);
		this.emit({ channel: "view", session: name, view: entry.view });
	}

	stateSet(name: string, key: string, value: string | null): void {
		const agent = this.must(name);
		void agent.stateKv.set(key, value);
		void agent.lane.publish([{ type: "eta", category: "state", action: value === null ? "delete" : "set", data: { key } }], BACKGROUND_CONTEXT).catch(() => undefined);
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
	async thinkingLevel(name: string, level: "off" | "minimal" | "low" | "medium" | "high"): Promise<void> {
		await this.must(name).lane.setThinkingLevel(level, BACKGROUND_CONTEXT);
		this.refreshView(name);
		void this.hosted.get(name)?.projector.snapshot(BACKGROUND_CONTEXT).then((view) => {
			const hosted = this.hosted.get(name);
			if (hosted === undefined) return;
			hosted.view = this.stampView(hosted, view);
			this.emit({ channel: "view", session: name, view: hosted.view });
		});
	}

	async modelSet(name: string, modelId: string): Promise<void> {
		const agent = this.must(name);
		this.setMeta(name, { modelId });
		if (this.hosted.get(name)?.created.faux === undefined) {
			const split = modelId.indexOf(":");
			const identity = split > 0 ? { provider: modelId.slice(0, split), modelId: modelId.slice(split + 1) } : { provider: "anthropic", modelId };
			try {
				await agent.lane.setModel(identity, BACKGROUND_CONTEXT);
			} catch {
				/* unknown id for this registry: keep the meta so it applies on next open */
			}
		}
	}

	/** Model catalog with no session context (welcome screen picker). */
	modelCatalog(): { models: { id: string; label: string }[]; current: string } {
		return this.modelCatalogFrom(this.etaConfig(), false);
	}

	modelInfo(name: string): { models: { id: string; label: string }[]; current: string } {
		const faux = this.hosted.get(name)?.created.faux;
		return this.modelCatalogFrom(this.etaConfig(), faux !== undefined, this.meta.get(name)?.modelId);
	}

	private modelCatalogFrom(cfg: EtaConfig, faux: boolean, currentOverride?: string): { models: { id: string; label: string }[]; current: string } {
		const configured = (cfg.providers ?? []).flatMap((provider) =>
			provider.models.map((model) => ({ id: `${provider.id}:${model.id}`, label: model.name ?? model.id })),
		);
		const fallback = configDefaultModel(cfg);
		const current = currentOverride ?? (configured.length > 0 ? fallback !== undefined ? `${fallback.provider}:${fallback.modelId}` : configured[0]!.id : undefined) ?? (faux ? "faux" : "claude-sonnet-4-5");
		if (configured.length > 0) return { models: configured, current };
		if (faux) return { models: [{ id: "faux", label: "faux echo" }], current };
		return { models: ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-1"].map((id) => ({ id: `anthropic:${id}`, label: id })), current };
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

	subscribe(listener: (frame: ChannelFrame) => void): () => void {
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

	private emit(frame: ChannelFrame): void {
		for (const listener of [...this.listeners]) listener(frame);
	}
}

export function listWorkspace(cwd: string): string[] {
	try {
		return readdirSync(cwd).filter((name) => !name.startsWith(".") && name !== "node_modules").slice(0, 24);
	} catch {
		return [];
	}
}
