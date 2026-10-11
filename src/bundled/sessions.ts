/**
 * The `sessions` plugin: the bundled feature that makes a server a session host.
 *
 * It is a plugin like any other — `apply(ctx)`, registrations through `ctx.wire`, effects
 * that die with it — and the only reason it ships in the box is that a session host is what
 * this server is for. Take it away and the pipe keeps running: `sessions.*` becomes "unknown
 * op", the sidebar's target disappears from `hello`, and nothing else notices.
 *
 * It owns three things:
 *
 * - **the actions**: create / delete / focus / resync / prompt / abort, the ones that move a
 *   session's row (rename / pin / archive), the one that branches it (fork), the one that compacts
 *   it on demand (compact), and the six that drive a side thread (btwOpen / btwAsk / btwAnswer /
 *   btwSave / btwHandoff / btwClear), and the one that stops a subagent (subagentStop);
 * - **the states**: `sessions` (the sidebar, eager, so a fresh client draws it from `hello`)
 *   and `sessions.<id>` (one session's view, registered when it opens, gone when it closes);
 * - **the traffic around a turn**: every kernel event on a session's bus becomes an `event`
 *   frame on that session's target, plus a state push — a subscribed client watches a run
 *   happen without asking for anything.
 *
 * What it deliberately does not own: how a session is assembled (harness `openSession`), how
 * a run ends (the runner), whether an inject starts a run (the harness pump), or durability
 * (the store). Policy stays where it already is; this file is wiring.
 */
import type { SidebarSession, SessionArgs, PromptImage, PromptInput } from "@eta/client-contracts";
import type { GoalState, ImageContent, StoredTask, Task, TaskStatus, ThinkingLevel } from "@eta/core";
import { THINKING_LEVELS, thinkingLevelsFor } from "@eta/core";
import { type AskResponse, type BtwSaveState, type BtwThread, sessionStateKV } from "@eta/harness";
import type { SessionFacts, SessionsApi, SessionsListener } from "@eta/plugin-sdk";
import { Service } from "cordis";
import type { CreateSessionOptions, ForkSessionOptions, ManagedSession, SessionManager } from "../manager";
import { formatModelId, parseModelId } from "../model-id";
import { firstHit, type HistoryPage, historyPageOf, type SearchHit } from "../search";
import type { SessionMeta } from "../store";
import type { WireService } from "../wire-service";

export { SESSION_ACTIONS, type SessionAction, type PromptImage, type PromptInput } from "@eta/client-contracts";

export interface SessionsPluginOptions {
	manager: SessionManager;
	/** Diagnostics. */
	warn?: ((message: string) => void) | undefined;
}

export type { SessionFacts, SessionsListener } from "@eta/plugin-sdk";

/** One open session, as this plugin tracks it. */
interface Attached {
	managed: ManagedSession;
	disposers: (() => void)[];
	running: boolean;
	updated: number;
}

/** Bus event names this plugin forwards. A new kernel event means one more line here. */
const FORWARDED_EVENTS = [
	"turn:run-start",
	"turn:run-end",
	"turn:start",
	"turn:end",
	"message:start",
	"message:update",
	"message:end",
	"entry:added",
	"tool:start",
	"tool:update",
	"tool:end",
	"usage:recorded",
	"goal:changed",
	"goal:cleared",
	"task:created",
	"task:updated",
	"task:removed",
	"compaction:start",
	"compaction:end",
	"retry:scheduled",
	"retry:end",
	"subagents:completed",
	"subagents:failed",
	"subagents:steered",
	"state:config-update",
	"queue:update",
] as const;

/** The session host, as a service other plugins inject (`ctx.sessions`). */
export class SessionsService extends Service implements SessionsApi {
	static readonly provide = "sessions";

	private readonly manager: SessionManager;
	private readonly wire: WireService;
	private readonly held = new Map<string, Attached>();
	/**
	 * What the store last told us, and nothing more: the *live* parts of a row (is it running,
	 * when did it last move) are read from `held` at projection time. A cached copy of those
	 * would be a sidebar that lies about who is working.
	 */
	private cached: { id: string; meta?: SessionMeta; broken?: string }[] = [];
	private focusedId: string | undefined;
	private offs: (() => void)[] = [];

	private readonly listeners = new Set<SessionsListener>();

	constructor(ctx: ConstructorParameters<typeof Service>[0], deps: { manager: SessionManager; wire: WireService }) {
		super(ctx, "sessions");
		this.manager = deps.manager;
		this.wire = deps.wire;
		// The sidebar is eager: a client that has just connected draws it from `hello`. The
		// store is asynchronous and a state projector must not be, so the last answer is kept
		// here and refreshed whenever something changed.
		this.offs.push(this.wire.stateOf("sessions", { project: () => this.sidebarState(), eager: true }));
		for (const managed of this.manager.openSessions()) this.attach(managed);
	}

	/**
	 * Everything this service put on the wire, taken back: the per-session state targets and
	 * bus subscriptions, the sessions themselves (their pumps stop), and the sidebar target.
	 * The registrations are plain bookkeeping in the registry, so this is what makes "unload
	 * the plugin" mean "the pipe forgets it".
	 */
	async dispose(): Promise<void> {
		for (const id of [...this.held.keys()]) await this.detach(id);
		for (const off of this.offs.splice(0)) off();
	}

	/** The sidebar as it stands: cached metadata, live status. */
	sidebar(): SidebarSession[] {
		return this.cached.map((entry) => this.row(entry));
	}

	/**
	 * Ask the store what exists (asynchronous), then tell subscribers the sidebar moved.
	 *
	 * Immediate, not paced: a sidebar that appears 600ms after the session was created reads as
	 * a broken button, and the store answered *now* — there is nothing left to coalesce.
	 */
	async refresh(): Promise<SidebarSession[]> {
		const listings = await this.manager.list();
		this.cached = listings.map((listing) =>
			listing.ok ? { id: listing.id, meta: listing.meta } : { id: listing.id, broken: listing.reason },
		);
		// An open session the store has not listed (created this instant) is still in the
		// sidebar: it is what the user is looking at.
		for (const id of this.heldIds()) {
			if (this.cached.some((entry) => entry.id === id)) continue;
			this.cached.push({ id, meta: this.held.get(id)?.managed.meta });
		}
		// A session that is no longer open cannot produce frames: its kernel is gone. Dropping
		// its wire presence here is what keeps a state target from outliving what it showed.
		for (const id of this.heldIds()) {
			if (this.manager.openSessions().some((open) => open.meta.id === id)) continue;
			await this.detach(id);
		}
		this.wire.pushNow("sessions");
		return this.sidebar();
	}

	async create(options: CreateSessionOptions): Promise<string> {
		const managed = await this.manager.create(options);
		this.attach(managed);
		await this.refresh();
		return managed.meta.id;
	}

	/** The sessions this plugin holds a wire presence for, by id. */
	heldIds(): string[] {
		return [...this.held.keys()].sort();
	}

	async focus(id: string): Promise<void> {
		const attached = await this.open(id);
		this.focusedId = id;
		for (const listener of this.listeners) listener.focused(id);
		this.wire.pushNow("sessions");
		// A plugin watching one session (a panel for the one in front) needs to know it is now the
		// one in front — and it needs the session to exist on its side before that.
		this.announce(attached);
	}

	focused(): string | undefined {
		return this.focusedId;
	}

	/** Queue an input, then let the harness pump decide that it starts a run. */
	async prompt(id: string, input: PromptInput): Promise<void> {
		const attached = await this.open(id);
		const kernel = attached.managed.session.kernel;
		const images = (input.images ?? []).map(toImageContent);
		const attachedImages = images.length === 0 ? undefined : images;
		// The mode is the inbox's kind: steering changes course at the next boundary, a queue
		// waits for the run in flight to end, and an idle session starts a run with it.
		if (input.mode === "steer") kernel.steer(input.text, attachedImages);
		else if (attached.running) kernel.followUp(input.text, attachedImages);
		else kernel.nextRun(input.text, attachedImages);
		attached.updated = Date.now();
		this.wire.pushNow("sessions");
		// Enqueueing through steer/followUp/nextRun does not announce itself on the bus (only
		// `inject` does), so the run start is this plugin's job to kick: the pump is what
		// decides whether a run is owed.
		attached.managed.session.pump.pump();
	}

	async abort(id: string): Promise<void> {
		(await this.open(id)).managed.session.runner.abort();
	}

	/** Close a session: its directory stays, its slot and its wire presence go. */
	async close(id: string): Promise<boolean> {
		const attached = this.held.get(id);
		if (attached === undefined) return false;
		await this.detach(id);
		await this.manager.close(id);
		await this.refresh();
		return true;
	}

	/** Close and forget: the row and the directory go too. */
	async remove(id: string): Promise<boolean> {
		const removed = await this.manager.remove(id);
		await this.detach(id);
		await this.refresh();
		return removed;
	}

	/**
	 * Change what the sidebar says about a session — its name, whether it is pinned or
	 * archived. Only the row moves; the running session is left exactly as it is.
	 */
	async setMeta(id: string, patch: Partial<Omit<SessionMeta, "id" | "createdAt" | "cwd">>): Promise<SessionMeta> {
		const meta = await this.manager.setMeta(id, patch);
		if (meta === undefined) throw new Error(`no such session: ${id}`);
		const attached = this.held.get(id);
		if (attached !== undefined) attached.managed.meta = meta;
		await this.refresh();
		return meta;
	}

	/** Branch a session off another one, and put the new one in front of the user. */
	async fork(sourceId: string, options: ForkSessionOptions): Promise<string> {
		if (!this.held.has(sourceId)) {
			const opened = await this.manager.session(sourceId);
			if (opened === undefined) throw new Error(`no such session: ${sourceId}`);
			this.attach(opened);
		}
		const forked = await this.manager.fork(sourceId, options);
		this.attach(forked);
		this.focusedId = forked.meta.id;
		await this.refresh();
		return forked.meta.id;
	}

	/**
	 * Compact a session on demand — `/compact`. Takes it out of the threshold's hands
	 * and does it now; a session assembled without a summarizer says so rather than
	 * pretending it did nothing.
	 */
	async compact(id: string, instructions?: string): Promise<boolean> {
		const compaction = (await this.open(id)).managed.session.compaction;
		if (compaction === undefined) throw new Error(`session ${id} has no compaction configured`);
		const compacted = await compaction.manual(instructions);
		this.wire.pushNow(`sessions.${id}`);
		return compacted;
	}

	/**
	 * Open a side thread. The two kinds differ in what they start from: a `contextual`
	 * thread is seeded with the session as it stands now (everything visible except the
	 * side chatter itself, so answers never compound), a `tangent` one starts empty.
	 */
	async btwOpen(id: string, kind: BtwThread["kind"]): Promise<BtwThread> {
		const attached = await this.open(id);
		const thread = attached.managed.session.btw.create(kind);
		const graph = attached.managed.session.log.graph;
		attached.managed.session.btw.seedFrom(thread.id, graph.pathOldestFirst(), graph.tipId());
		this.wire.pushNow(`sessions.${id}`);
		return thread;
	}

	/**
	 * Ask a side thread. The wait belongs to the thread (`pending`), and the frame
	 * showing that goes out before the answer does: a side request that takes seconds
	 * must not look frozen. `ask` settles into an answer or an error, never a rejection.
	 */
	async btwAsk(id: string, threadId: string, question: string): Promise<void> {
		const attached = await this.open(id);
		this.requireThread(attached, threadId);
		const settled = attached.managed.session.btw.ask(threadId, question);
		this.wire.pushNow(`sessions.${id}`);
		await settled;
		this.wire.pushNow(`sessions.${id}`);
	}

	/** Record an exchange without asking a model (a note, a question the user answered). */
	async btwAnswer(id: string, threadId: string, question: string, answer: string): Promise<void> {
		const attached = await this.open(id);
		this.requireThread(attached, threadId);
		attached.managed.session.btw.answer(threadId, question, answer);
		this.wire.pushNow(`sessions.${id}`);
	}

	/** Save a thread's notes as a visible note; mid-run they queue for the boundary. */
	async btwSave(id: string, threadId: string): Promise<BtwSaveState> {
		const attached = await this.open(id);
		this.requireThread(attached, threadId);
		const state = await attached.managed.session.btw.save(threadId, attached.running);
		this.wire.pushNow(`sessions.${id}`);
		return state;
	}

	/**
	 * Hand a thread's notes to the main run. While a run is in flight they arrive as a
	 * follow-up it folds in at its next boundary; with nothing running they *are* the
	 * next run — a follow-up with nothing to attach to would sit unread.
	 */
	async btwHandoff(id: string, threadId: string): Promise<boolean> {
		const attached = await this.open(id);
		this.requireThread(attached, threadId);
		const text = attached.managed.session.btw.handoff(threadId);
		this.wire.pushNow(`sessions.${id}`);
		if (text === undefined) return false;
		if (attached.running) attached.managed.session.kernel.followUp(text);
		else attached.managed.session.kernel.nextRun(text);
		attached.managed.session.pump.pump();
		return true;
	}

	/**
	 * Switch the model.
	 *
	 * A session reads its configuration every turn, so the next run uses the new model and a
	 * replay comes back on it (the choice is written to the journal's config and to the row).
	 * Three things make this more than an assignment:
	 *
	 * - **Not while it is running.** The run in flight assembled its request with the old
	 *   model; switching under it would leave the transcript claiming one model and the next
	 *   request using another.
	 * - **The model has to resolve.** A name nobody serves is `model_unavailable` now, rather
	 *   than a run that fails a minute later.
	 * - **The history is re-measured.** A smaller window does not shrink what was written
	 *   under a bigger one, so the switch compacts when the history no longer fits — that is
	 *   the one moment the session knows the window changed.
	 */
	async modelSet(id: string, model: string): Promise<{ model: string; thinkingLevel: ThinkingLevel }> {
		const attached = await this.open(id);
		if (attached.running) throw new Error(`session ${id} is busy: the model cannot change mid-run`);
		const identity = parseModelId(model);
		const resolved = attached.managed.session.models.getModel(identity.provider, identity.modelId);
		if (resolved === undefined) throw new Error(`model_unavailable: ${model}`);
		// A model that cannot think cannot be asked to: clamp instead of sending a level it does
		// not have (and keep the level otherwise — the choice was the user's, not the model's).
		const supported = thinkingLevelsFor(resolved);
		const current = attached.managed.session.kernel.config.read("thinkingLevel");
		const level: ThinkingLevel = supported.includes(current) ? current : "off";
		attached.managed.session.kernel.config.update({
			model: identity,
			...(level === current ? {} : { thinkingLevel: level }),
		});
		await this.manager.setMeta(id, { model: formatModelId(identity) });
		await attached.managed.session.compaction?.threshold().catch(() => false);
		await this.refresh();
		return { model: formatModelId(identity), thinkingLevel: level };
	}

	/** How much thinking the model should do — checked against what this model accepts. */
	async thinkingLevel(id: string, level: ThinkingLevel): Promise<ThinkingLevel> {
		const attached = await this.open(id);
		const identity = attached.managed.session.kernel.config.read("model");
		const supported = thinkingLevelsFor(
			attached.managed.session.models.getModel(identity.provider, identity.modelId),
		);
		if (!supported.includes(level)) {
			throw new Error(`${identity.provider}:${identity.modelId} does not support thinking level ${level}`);
		}
		attached.managed.session.kernel.config.update({ thinkingLevel: level });
		this.wire.pushNow(`sessions.${id}`);
		return level;
	}

	/**
	 * Take a queued input back out of the inbox.
	 *
	 * The outcome is the reason this answers at all: the chip disappears from the composer
	 * either way, but only a cancel that beat the run lets the client hand the text back —
	 * an entry the journal already holds was consumed, and one the journal has never seen was
	 * never there.
	 */
	async queueRemove(id: string, entryId: string): Promise<"cancelled" | "already_consumed" | "not_found"> {
		const attached = await this.open(id);
		if (attached.managed.session.kernel.inbox.cancel(entryId)) {
			this.wire.pushNow(`sessions.${id}`);
			return "cancelled";
		}
		const stored = await attached.managed.session.log.storage.getEntries([entryId]);
		return stored.has(entryId) ? "already_consumed" : "not_found";
	}

	/**
	 * Set, pause, resume or clear the goal — and, when a goal is set on an idle session,
	 * start the work: saying "work on this" and then waiting to be asked twice would make
	 * the op a note rather than an instruction (eta-agent's rule, kept).
	 */
	async goal(
		id: string,
		action: "set" | "pause" | "resume" | "clear",
		objective?: string,
	): Promise<GoalState | undefined> {
		const attached = await this.open(id);
		const goal = attached.managed.session.kernel.goal;
		if (action === "set") {
			if (objective === undefined || objective.trim().length === 0) {
				throw new Error("sessions.goal with action 'set' needs an objective");
			}
			goal.set(objective);
		} else if (action === "pause") goal.pause();
		else if (action === "resume") goal.resume();
		else goal.clear();
		this.wire.pushNow(`sessions.${id}`);
		// Setting a goal means "start working on it": an idle session gets the first push here
		// (the continuation prompt after that is the loop's own business).
		if (action === "set" && !attached.running) await this.prompt(id, { text: `Work toward the goal: ${objective}` });
		return goal.current;
	}

	/** A task on the session's ledger. The ledger lives in the journal, so this is durable. */
	async taskCreate(id: string, content: string, priority?: Task["priority"]): Promise<StoredTask> {
		const attached = await this.open(id);
		const task = attached.managed.session.kernel.tasks.create(
			content,
			priority === undefined ? {} : { priority },
		).task;
		this.wire.pushNow(`sessions.${id}`);
		return task;
	}

	/** Rename, reprioritise, re-status or re-wire a task's dependencies. */
	async taskUpdate(
		id: string,
		taskId: string,
		patch: { content?: string; status?: TaskStatus; deps?: string[]; priority?: Task["priority"] },
	): Promise<StoredTask> {
		const attached = await this.open(id);
		const updated = attached.managed.session.kernel.tasks.update(taskId, patch);
		if (updated === undefined) throw new Error(`no such task: ${taskId}`);
		this.wire.pushNow(`sessions.${id}`);
		return updated.task;
	}

	async taskRemove(id: string, taskId: string): Promise<boolean> {
		const attached = await this.open(id);
		const removed = attached.managed.session.kernel.tasks.remove(taskId);
		this.wire.pushNow(`sessions.${id}`);
		return removed;
	}

	/** Forget one key of the model's own state (`update_state`) — the delete half of it. */
	async stateDelete(id: string, key: string): Promise<void> {
		const attached = await this.open(id);
		await sessionStateKV(attached.managed.session.log, attached.managed.session.journaling).set(key, null);
		this.wire.pushNow(`sessions.${id}`);
	}

	/**
	 * Answer the question a session is waiting on. The response shape is the ask channel's
	 * own (`selection` / `freeform` / `none`); an answer for something that is not waiting is
	 * a `false`, which the caller may or may not care about — the op reports it.
	 */
	async answer(id: string, questionId: string, response: unknown): Promise<boolean> {
		const attached = await this.open(id);
		const ask = attached.managed.session.ask;
		if (ask === undefined) throw new Error(`session ${id} has no ask channel`);
		const answered = ask.answer(questionId, response as AskResponse);
		this.wire.pushNow(`sessions.${id}`);
		return answered;
	}

	/**
	 * Drop a pending question, and the run waiting on it: a question nobody will answer must
	 * not leave a turn hanging, and the run is what is doing the waiting.
	 */
	async askAbort(id: string, questionId: string): Promise<boolean> {
		const attached = await this.open(id);
		const aborted = attached.managed.session.ask?.abort(questionId) ?? false;
		await this.abort(id);
		this.wire.pushNow(`sessions.${id}`);
		return aborted;
	}

	/**
	 * Stop one subagent — and, with it, everything it spawned.
	 *
	 * The pool refuses an id it does not know, and the wire op acts as the root (`byId`
	 * undefined), which is the only agent allowed to reach the whole tree: the user is not
	 * a sibling.
	 */
	async subagentStop(id: string, subagentId: string): Promise<void> {
		const attached = await this.open(id);
		const pool = attached.managed.session.subagents;
		if (pool === undefined) throw new Error(`session ${id} cannot spawn subagents`);
		pool.stop(subagentId, undefined);
		this.wire.pushNow(`sessions.${id}`);
	}

	/**
	 * A page of one session's transcript, oldest-first, ending just before `beforeSeq`.
	 *
	 * The page comes from the session's own *branch* — the journal it replayed — rather than from
	 * the windowed view a client holds: a client that scrolled past what it has asks for what came
	 * before a sequence number, and the answer is the conversation, not the window.
	 */
	async history(id: string, options: { beforeSeq?: number; limit?: number } = {}): Promise<HistoryPage> {
		const attached = await this.open(id);
		const limit = Math.max(1, Math.min(500, options.limit ?? 100));
		return historyPageOf(attached.managed.session.log.graph.pathOldestFirst(), {
			...(options.beforeSeq === undefined ? {} : { beforeSeq: options.beforeSeq }),
			limit,
		});
	}

	/**
	 * Which sessions mention something.
	 *
	 * The search walks every session this plugin holds open, one hit each: the answer a search box
	 * gives is "this session has it, and here is roughly where", and twenty matches inside one long
	 * conversation are not more useful than the conversation.
	 *
	 * A session that is not open is not searched — opening every session to answer a keystroke is
	 * the cost this deliberately does not pay, and `list` plus `focus` are how a client reaches one
	 * it has not opened.
	 */
	search(query: string): SearchHit[] {
		const hits: SearchHit[] = [];
		for (const id of this.heldIds()) {
			const attached = this.held.get(id);
			if (attached === undefined) continue;
			const hit = firstHit(id, attached.managed.session.log.graph.pathOldestFirst(), query);
			if (hit !== undefined) hits.push(hit);
		}
		return hits;
	}

	/** Drop a thread from the panel; notes already written to the journal stay. */
	async btwClear(id: string, threadId: string): Promise<boolean> {
		const attached = await this.open(id);
		this.requireThread(attached, threadId);
		const cleared = attached.managed.session.btw.clear(threadId);
		this.wire.pushNow(`sessions.${id}`);
		return cleared;
	}

	session(id: string): ManagedSession | undefined {
		return this.held.get(id)?.managed;
	}

	/** Watch one session: its bus becomes events, its view becomes a state target. */
	attach(managed: ManagedSession): void {
		if (this.held.has(managed.meta.id)) return;
		const id = managed.meta.id;
		const attached: Attached = { managed, disposers: [], running: false, updated: Date.now() };
		this.held.set(id, attached);
		for (const listener of this.listeners) listener.opened(factsOf(attached));
		// Whether an inject becomes a run is the host's policy, and this host's answer is yes.
		managed.session.pump.start();

		attached.disposers.push(
			this.wire.stateOf(`sessions.${id}`, { project: () => managed.session.view.snapshot() }),
			subscribeBus(managed, (name, payload) => {
				if (name === "turn:run-start") attached.running = true;
				if (name === "turn:run-end") attached.running = false;
				attached.updated = Date.now();
				this.announce(attached);
				this.wire.event(`sessions.${id}`, name, payload);
				// Paced, not immediate: this is run traffic (a streamed token is an event), and
				// it is exactly what the budget exists for.
				this.wire.push(`sessions.${id}`);
				this.wire.push("sessions");
			}),
		);
	}

	/** The sidebar's state: rows plus the focused id, as one section. */
	private sidebarState(): { sections: Record<string, unknown>; revisions: Record<string, string> } {
		const list = this.sidebar();
		return {
			sections: { list, focused: this.focusedId ?? null },
			// Cheap on purpose: ids, what a row shows, and who is focused.
			revisions: {
				list: list
					.map((row) => `${row.id}:${row.updated ?? 0}:${row.badges.join("+")}:${row.broken ?? ""}`)
					.join("|"),
				focused: this.focusedId ?? "",
			},
		};
	}

	/** One row: what the store said about it, plus what is true about it right now. */
	private row(entry: { id: string; meta?: SessionMeta; broken?: string }): SidebarSession {
		const attached = this.held.get(entry.id);
		const meta = entry.meta;
		return {
			id: entry.id,
			...(meta?.title === undefined ? {} : { title: meta.title }),
			...(meta?.cwd === undefined ? {} : { cwd: meta.cwd }),
			...(meta?.createdAt === undefined ? {} : { createdAt: meta.createdAt }),
			...(meta?.pinned === true ? { pinned: true } : {}),
			...(meta?.archived === true ? { archived: true } : {}),
			...(attached === undefined ? {} : { updated: attached.updated }),
			...(entry.broken === undefined || entry.broken.length === 0 ? {} : { broken: entry.broken }),
			badges: attached?.running === true ? ["running"] : [],
			personas: meta?.persona === undefined ? [] : [meta.persona],
		};
	}

	/**
	 * The session behind an id, whether this plugin is holding it or not.
	 *
	 * The store is the truth: a session exists because it has a row, and being *held* is
	 * just "its wire presence has been set up". So an action on a session that is not open
	 * yet opens it — the alternative is a server where only sessions created in this run
	 * can be used, which is every session after a restart.
	 */
	async open(id: string): Promise<Attached> {
		// The manager is the truth about what is open: asking it every time is what makes a
		// session closed behind this plugin's back (a shutdown, a restart's worth of state
		// that was never held) stop being a session this plugin thinks it can act on.
		const opened = await this.manager.session(id);
		if (opened === undefined) throw new Error(`no such session: ${id}`);
		const held = this.held.get(id);
		if (held !== undefined && held.managed === opened) return held;
		if (held !== undefined) await this.detach(id);
		this.attach(opened);
		const attached = this.held.get(id);
		if (attached === undefined) throw new Error(`session ${id} could not be attached`);
		return attached;
	}

	/** A thread id that is not in the panel is an error, not an operation that quietly does nothing. */
	private requireThread(attached: Attached, threadId: string): void {
		if (attached.managed.session.btw.get(threadId) === undefined) {
			throw new Error(`no such side thread: ${threadId}`);
		}
	}

	/**
	 * Listen for what happens to sessions. The returned function stops listening, which is what a
	 * plugin's effect returns.
	 */
	subscribe(listener: SessionsListener): () => void {
		this.listeners.add(listener);
		// A plugin that subscribes late is told what already exists: "who is there" is a fact, not
		// an event, and a plugin that missed the opening would otherwise never hear about it.
		for (const attached of this.held.values()) listener.opened(factsOf(attached));
		return () => {
			this.listeners.delete(listener);
		};
	}

	private announce(attached: Attached): void {
		const facts = factsOf(attached);
		for (const listener of this.listeners) listener.changed(facts);
	}

	private async detach(id: string): Promise<void> {
		for (const listener of this.listeners) listener.closed(id);
		const attached = this.held.get(id);
		if (attached === undefined) return;
		this.held.delete(id);
		for (const off of attached.disposers.splice(0)) off();
		attached.managed.session.pump.stop();
	}
}

/** The plugin, in the shape the loader understands: a name, an inject, an apply. */
export function sessionsPlugin(options: SessionsPluginOptions) {
	return {
		name: "sessions",
		inject: ["wire"],
		apply(ctx: unknown): unknown {
			// The ctx a plugin is applied on, with the two things this plugin needs: the wire
			// service (declared in `inject`) and `effect`, which is how a plugin promises that
			// everything it registers dies with it.
			const context = ctx as {
				wire: WireService;
				effect(execute: () => () => unknown): unknown;
			} & ConstructorParameters<typeof Service>[0];
			const wire = context.wire;

			return context.effect(() => {
				const service = new SessionsService(context, { manager: options.manager, wire });
				void service.refresh();
				const registrations: (() => void)[] = [];

				// One registration per action, in the shape any plugin would use — which is the
				// only reason they live here rather than in a privileged API surface.
				registrations.push(
					wire.handle("sessions", "create", async (call) => {
						const args = (call.args ?? {}) as Partial<SessionArgs["create"]>;
						const session = await service.create({ ...args, cwd: args.cwd ?? process.cwd() });
						return { result: { session } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "prompt", async (call) => {
						const args = (call.args ?? {}) as Partial<SessionArgs["prompt"]>;
						if (args.session === undefined || args.text === undefined) {
							throw new Error("sessions.prompt needs a session and a text");
						}
						await service.prompt(args.session, {
							text: args.text,
							...(args.mode === undefined ? {} : { mode: args.mode }),
							...(args.images === undefined ? {} : { images: args.images }),
						});
						return { result: { session: args.session, queued: true } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "abort", async (call) => {
						const { session } = (call.args ?? {}) as Partial<SessionArgs["abort"]>;
						if (session === undefined) throw new Error("sessions.abort needs a session");
						await service.abort(session);
						return {};
					}),
				);
				registrations.push(
					wire.handle("sessions", "focus", async (call) => {
						const { session } = (call.args ?? {}) as Partial<SessionArgs["focus"]>;
						if (session === undefined) throw new Error("sessions.focus needs a session");
						await service.focus(session);
						return {};
					}),
				);
				registrations.push(
					wire.handle("sessions", "delete", async (call) => {
						const { session } = (call.args ?? {}) as Partial<SessionArgs["delete"]>;
						if (session === undefined) throw new Error("sessions.delete needs a session");
						return { result: { removed: await service.remove(session) } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "rename", async (call) => {
						const { session, title } = (call.args ?? {}) as Partial<SessionArgs["rename"]>;
						if (session === undefined) throw new Error("sessions.rename needs a session");
						// An empty title is a clear, not a rename to "" — the sidebar shows the cwd then.
						const meta = await service.setMeta(session, {
							title: title === undefined || title.trim() === "" ? undefined : title,
						});
						return { result: { session, title: meta.title ?? null } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "pin", async (call) => {
						const { session, pinned } = (call.args ?? {}) as Partial<SessionArgs["pin"]>;
						if (session === undefined) throw new Error("sessions.pin needs a session");
						if (typeof pinned !== "boolean") throw new Error("sessions.pin needs pinned: true or false");
						await service.setMeta(session, { pinned });
						return { result: { session, pinned } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "archive", async (call) => {
						const { session, archived } = (call.args ?? {}) as Partial<SessionArgs["archive"]>;
						if (session === undefined) throw new Error("sessions.archive needs a session");
						if (typeof archived !== "boolean") {
							throw new Error("sessions.archive needs archived: true or false");
						}
						await service.setMeta(session, { archived });
						return { result: { session, archived } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "fork", async (call) => {
						const args = (call.args ?? {}) as Partial<SessionArgs["fork"]>;
						if (args.session === undefined) throw new Error("sessions.fork needs a session");
						const session = await service.fork(args.session, {
							...(args.entryId === undefined ? {} : { entryId: args.entryId }),
							...(args.position === undefined ? {} : { position: args.position }),
							...(args.title === undefined ? {} : { title: args.title }),
						});
						return { result: { session } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "compact", async (call) => {
						const { session, instructions } = (call.args ?? {}) as Partial<SessionArgs["compact"]>;
						if (session === undefined) throw new Error("sessions.compact needs a session");
						const compacted = await service.compact(session, instructions);
						return { result: { session, compacted } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "btwOpen", async (call) => {
						const { session, kind } = (call.args ?? {}) as Partial<SessionArgs["btwOpen"]>;
						if (session === undefined) throw new Error("sessions.btwOpen needs a session");
						if (kind !== "contextual" && kind !== "tangent") {
							throw new Error("sessions.btwOpen needs kind: contextual or tangent");
						}
						const thread = await service.btwOpen(session, kind);
						return { result: { session, thread } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "btwAsk", async (call) => {
						const { session, threadId, question } = (call.args ?? {}) as Partial<SessionArgs["btwAsk"]>;
						if (session === undefined || threadId === undefined || question === undefined) {
							throw new Error("sessions.btwAsk needs a session, a threadId and a question");
						}
						await service.btwAsk(session, threadId, question);
						return { result: { session, threadId } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "btwAnswer", async (call) => {
						const { session, threadId, question, answer } = (call.args ?? {}) as Partial<
							SessionArgs["btwAnswer"]
						>;
						if (session === undefined || threadId === undefined || question === undefined) {
							throw new Error("sessions.btwAnswer needs a session, a threadId and a question");
						}
						await service.btwAnswer(session, threadId, question, answer ?? "");
						return { result: { session, threadId } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "btwSave", async (call) => {
						const { session, threadId } = (call.args ?? {}) as Partial<SessionArgs["btwSave"]>;
						if (session === undefined || threadId === undefined) {
							throw new Error("sessions.btwSave needs a session and a threadId");
						}
						return { result: { state: await service.btwSave(session, threadId) } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "btwHandoff", async (call) => {
						const { session, threadId } = (call.args ?? {}) as Partial<SessionArgs["btwHandoff"]>;
						if (session === undefined || threadId === undefined) {
							throw new Error("sessions.btwHandoff needs a session and a threadId");
						}
						return { result: { delivered: await service.btwHandoff(session, threadId) } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "btwClear", async (call) => {
						const { session, threadId } = (call.args ?? {}) as Partial<SessionArgs["btwClear"]>;
						if (session === undefined || threadId === undefined) {
							throw new Error("sessions.btwClear needs a session and a threadId");
						}
						return { result: { cleared: await service.btwClear(session, threadId) } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "subagentStop", async (call) => {
						const { session, id } = (call.args ?? {}) as Partial<SessionArgs["subagentStop"]>;
						if (session === undefined || id === undefined) {
							throw new Error("sessions.subagentStop needs a session and an id");
						}
						await service.subagentStop(session, id);
						return { result: { session, id } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "goal", async (call) => {
						const { session, action, objective } = (call.args ?? {}) as Partial<SessionArgs["goal"]>;
						if (session === undefined) throw new Error("sessions.goal needs a session");
						if (action !== "set" && action !== "pause" && action !== "resume" && action !== "clear") {
							throw new Error("sessions.goal needs action: set, pause, resume or clear");
						}
						const goal = await service.goal(session, action, objective);
						return { result: { session, action, goal: goal ?? null } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "taskCreate", async (call) => {
						const { session, content, priority } = (call.args ?? {}) as Partial<SessionArgs["taskCreate"]>;
						if (session === undefined || content === undefined) {
							throw new Error("sessions.taskCreate needs a session and a content");
						}
						return { result: { task: await service.taskCreate(session, content, priority) } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "taskUpdate", async (call) => {
						const { session, id, ...patch } = (call.args ?? {}) as Partial<SessionArgs["taskUpdate"]>;
						if (session === undefined || id === undefined) {
							throw new Error("sessions.taskUpdate needs a session and an id");
						}
						return { result: { task: await service.taskUpdate(session, id, patch) } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "taskSet", async (call) => {
						const { session, id, status } = (call.args ?? {}) as Partial<SessionArgs["taskSet"]>;
						if (session === undefined || id === undefined || status === undefined) {
							throw new Error("sessions.taskSet needs a session, an id and a status");
						}
						return { result: { task: await service.taskUpdate(session, id, { status }) } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "taskRemove", async (call) => {
						const { session, id } = (call.args ?? {}) as Partial<SessionArgs["taskRemove"]>;
						if (session === undefined || id === undefined) {
							throw new Error("sessions.taskRemove needs a session and an id");
						}
						return { result: { removed: await service.taskRemove(session, id) } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "stateDelete", async (call) => {
						const { session, key } = (call.args ?? {}) as Partial<SessionArgs["stateDelete"]>;
						if (session === undefined || key === undefined) {
							throw new Error("sessions.stateDelete needs a session and a key");
						}
						await service.stateDelete(session, key);
						return { result: { session, key } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "answer", async (call) => {
						const { session, questionId, response } = (call.args ?? {}) as Partial<SessionArgs["answer"]>;
						if (session === undefined || questionId === undefined) {
							throw new Error("sessions.answer needs a session and a questionId");
						}
						return { result: { answered: await service.answer(session, questionId, response) } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "askAbort", async (call) => {
						const { session, questionId } = (call.args ?? {}) as Partial<SessionArgs["askAbort"]>;
						if (session === undefined || questionId === undefined) {
							throw new Error("sessions.askAbort needs a session and a questionId");
						}
						return { result: { aborted: await service.askAbort(session, questionId) } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "modelSet", async (call) => {
						const { session, model } = (call.args ?? {}) as Partial<SessionArgs["modelSet"]>;
						if (session === undefined || model === undefined) {
							throw new Error("sessions.modelSet needs a session and a model");
						}
						return { result: await service.modelSet(session, model) };
					}),
				);
				registrations.push(
					wire.handle("sessions", "thinkingLevel", async (call) => {
						const { session, level } = (call.args ?? {}) as Partial<SessionArgs["thinkingLevel"]>;
						if (session === undefined || level === undefined) {
							throw new Error("sessions.thinkingLevel needs a session and a level");
						}
						if (!THINKING_LEVELS.includes(level)) throw new Error(`unknown thinking level: ${level}`);
						return { result: { session, level: await service.thinkingLevel(session, level) } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "queueRemove", async (call) => {
						const { session, entryId } = (call.args ?? {}) as Partial<SessionArgs["queueRemove"]>;
						if (session === undefined || entryId === undefined) {
							throw new Error("sessions.queueRemove needs a session and an entryId");
						}
						return { result: { entryId, outcome: await service.queueRemove(session, entryId) } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "history", async (call) => {
						const args = (call.args ?? {}) as Partial<SessionArgs["history"]>;
						if (args.session === undefined) throw new Error("sessions.history needs a session");
						const { rows, systems } = await service.history(args.session, {
							...(args.beforeSeq === undefined ? {} : { beforeSeq: args.beforeSeq }),
							...(args.limit === undefined ? {} : { limit: args.limit }),
						});
						return { result: { session: args.session, rows, systems } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "search", (call) => {
						const { query } = (call.args ?? {}) as Partial<SessionArgs["search"]>;
						if (query === undefined) throw new Error("sessions.search needs a query");
						// A read, not a subscription: the hits are the answer to this question, and a
						// search box asks it again when the query changes.
						return { result: { query, hits: service.search(query) } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "resync", async (call) => {
						// A resync is a read: it answers with the current state of one session's target.
						// It opens the session when nobody holds it yet — the client is asking to be
						// caught up, and "it is not open" is not an answer to that.
						const { session } = (call.args ?? {}) as Partial<SessionArgs["resync"]>;
						if (session === undefined) throw new Error("sessions.resync needs a session");
						await service.open(session);
						const state = wire.snapshot(`sessions.${session}`);
						if (state === undefined) throw new Error(`no such session: ${session}`);
						return { result: { session, state } };
					}),
				);

				return async () => {
					for (const off of registrations.splice(0)) off();
					await service.dispose();
				};
			});
		},
	};
}

/** The bus is a cordis context: subscribe by name, get a disposer back. */
function subscribeBus(managed: ManagedSession, onEvent: (name: string, payload: unknown) => void): () => void {
	const ctx = managed.session.kernel.ctx as unknown as {
		on(name: string, listener: (payload: unknown) => void): () => boolean;
	};
	const offs = FORWARDED_EVENTS.map((name) => ctx.on(name, (payload) => onEvent(name, payload)));
	return () => {
		for (const off of offs) off();
	};
}

/** What a plugin needs to know about a session: where it works, and whether it is busy. */
function factsOf(attached: Attached): SessionFacts {
	return {
		id: attached.managed.meta.id,
		cwd: attached.managed.meta.cwd,
		...(attached.managed.meta.title === undefined ? {} : { title: attached.managed.meta.title }),
		running: attached.running,
	};
}

function toImageContent(image: PromptImage): ImageContent {
	return { type: "image", mimeType: image.mime, data: image.dataBase64 } as ImageContent;
}
