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
 *   btwSave / btwHandoff / btwClear);
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
import type { SidebarSession } from "@eta/client-wire-proto";
import type { ImageContent } from "@eta/core";
import type { BtwSaveState, BtwThread } from "@eta/harness";
import { Service } from "cordis";
import type { CreateSessionOptions, ForkSessionOptions, ManagedSession, SessionManager } from "../manager";
import type { SessionMeta } from "../store";
import type { WireService } from "../wire-service";

/** The actions this target has. One list, so the wire and the plugin cannot disagree. */
export const SESSION_ACTIONS = [
	"create",
	"delete",
	"focus",
	"resync",
	"prompt",
	"abort",
	"rename",
	"pin",
	"archive",
	"fork",
	"compact",
	"btwOpen",
	"btwAsk",
	"btwAnswer",
	"btwSave",
	"btwHandoff",
	"btwClear",
] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];

export interface PromptImage {
	mime: string;
	dataBase64: string;
}

export interface PromptInput {
	text: string;
	mode?: "queue" | "steer" | undefined;
	images?: PromptImage[] | undefined;
}

export interface SessionsPluginOptions {
	manager: SessionManager;
	/** Diagnostics. */
	warn?: ((message: string) => void) | undefined;
}

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
	"state:config-update",
	"queue:update",
] as const;

/** The session host, as a service other plugins inject (`ctx.sessions`). */
export class SessionsService extends Service {
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

	/** Ask the store what exists (asynchronous), then tell subscribers the sidebar moved. */
	async refresh(): Promise<SidebarSession[]> {
		const listings = await this.manager.list();
		this.cached = listings.map((listing) =>
			listing.ok ? { id: listing.id, meta: listing.meta } : { id: listing.id, broken: listing.reason },
		);
		// An open session the store has not listed (created this instant) is still in the
		// sidebar: it is what the user is looking at.
		for (const id of this.open()) {
			if (this.cached.some((entry) => entry.id === id)) continue;
			this.cached.push({ id, meta: this.held.get(id)?.managed.meta });
		}
		this.wire.push("sessions");
		return this.sidebar();
	}

	async create(options: CreateSessionOptions): Promise<string> {
		const managed = await this.manager.create(options);
		this.attach(managed);
		await this.refresh();
		return managed.meta.id;
	}

	open(): string[] {
		return [...this.held.keys()].sort();
	}

	focus(id: string): void {
		if (!this.held.has(id)) throw new Error(`no such session: ${id}`);
		this.focusedId = id;
		this.wire.push("sessions");
	}

	focused(): string | undefined {
		return this.focusedId;
	}

	/** Queue an input, then let the harness pump decide that it starts a run. */
	prompt(id: string, input: PromptInput): void {
		const attached = this.require(id);
		const kernel = attached.managed.session.kernel;
		const images = (input.images ?? []).map(toImageContent);
		const attachedImages = images.length === 0 ? undefined : images;
		// The mode is the inbox's kind: steering changes course at the next boundary, a queue
		// waits for the run in flight to end, and an idle session starts a run with it.
		if (input.mode === "steer") kernel.steer(input.text, attachedImages);
		else if (attached.running) kernel.followUp(input.text, attachedImages);
		else kernel.nextRun(input.text, attachedImages);
		attached.updated = Date.now();
		this.wire.push("sessions");
		// Enqueueing through steer/followUp/nextRun does not announce itself on the bus (only
		// `inject` does), so the run start is this plugin's job to kick: the pump is what
		// decides whether a run is owed.
		attached.managed.session.pump.pump();
	}

	abort(id: string): void {
		this.require(id).managed.session.runner.abort();
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
		const compaction = this.require(id).managed.session.compaction;
		if (compaction === undefined) throw new Error(`session ${id} has no compaction configured`);
		const compacted = await compaction.manual(instructions);
		this.wire.push(`sessions.${id}`);
		return compacted;
	}

	/**
	 * Open a side thread. The two kinds differ in what they start from: a `contextual`
	 * thread is seeded with the session as it stands now (everything visible except the
	 * side chatter itself, so answers never compound), a `tangent` one starts empty.
	 */
	btwOpen(id: string, kind: BtwThread["kind"]): BtwThread {
		const attached = this.require(id);
		const thread = attached.managed.session.btw.create(kind);
		const graph = attached.managed.session.log.graph;
		attached.managed.session.btw.seedFrom(thread.id, graph.pathOldestFirst(), graph.tipId());
		this.wire.push(`sessions.${id}`);
		return thread;
	}

	/**
	 * Ask a side thread. The wait belongs to the thread (`pending`), and the frame
	 * showing that goes out before the answer does: a side request that takes seconds
	 * must not look frozen. `ask` settles into an answer or an error, never a rejection.
	 */
	async btwAsk(id: string, threadId: string, question: string): Promise<void> {
		const attached = this.require(id);
		this.requireThread(attached, threadId);
		const settled = attached.managed.session.btw.ask(threadId, question);
		this.wire.push(`sessions.${id}`);
		await settled;
		this.wire.push(`sessions.${id}`);
	}

	/** Record an exchange without asking a model (a note, a question the user answered). */
	btwAnswer(id: string, threadId: string, question: string, answer: string): void {
		const attached = this.require(id);
		this.requireThread(attached, threadId);
		attached.managed.session.btw.answer(threadId, question, answer);
		this.wire.push(`sessions.${id}`);
	}

	/** Save a thread's notes as a visible note; mid-run they queue for the boundary. */
	async btwSave(id: string, threadId: string): Promise<BtwSaveState> {
		const attached = this.require(id);
		this.requireThread(attached, threadId);
		const state = await attached.managed.session.btw.save(threadId, attached.running);
		this.wire.push(`sessions.${id}`);
		return state;
	}

	/**
	 * Hand a thread's notes to the main run. While a run is in flight they arrive as a
	 * follow-up it folds in at its next boundary; with nothing running they *are* the
	 * next run — a follow-up with nothing to attach to would sit unread.
	 */
	btwHandoff(id: string, threadId: string): boolean {
		const attached = this.require(id);
		this.requireThread(attached, threadId);
		const text = attached.managed.session.btw.handoff(threadId);
		this.wire.push(`sessions.${id}`);
		if (text === undefined) return false;
		if (attached.running) attached.managed.session.kernel.followUp(text);
		else attached.managed.session.kernel.nextRun(text);
		attached.managed.session.pump.pump();
		return true;
	}

	/** Drop a thread from the panel; notes already written to the journal stay. */
	btwClear(id: string, threadId: string): boolean {
		const attached = this.require(id);
		this.requireThread(attached, threadId);
		const cleared = attached.managed.session.btw.clear(threadId);
		this.wire.push(`sessions.${id}`);
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
		// Whether an inject becomes a run is the host's policy, and this host's answer is yes.
		managed.session.pump.start();

		attached.disposers.push(
			this.wire.stateOf(`sessions.${id}`, { project: () => managed.session.view.snapshot() }),
			subscribeBus(managed, (name, payload) => {
				if (name === "turn:run-start") attached.running = true;
				if (name === "turn:run-end") attached.running = false;
				attached.updated = Date.now();
				this.wire.event(`sessions.${id}`, name, payload);
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

	private require(id: string): Attached {
		const attached = this.held.get(id);
		if (attached === undefined) throw new Error(`no such session: ${id}`);
		return attached;
	}

	/** A thread id that is not in the panel is an error, not an operation that quietly does nothing. */
	private requireThread(attached: Attached, threadId: string): void {
		if (attached.managed.session.btw.get(threadId) === undefined) {
			throw new Error(`no such side thread: ${threadId}`);
		}
	}

	private async detach(id: string): Promise<void> {
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
						const args = (call.args ?? {}) as CreateSessionOptions;
						const session = await service.create({ ...args, cwd: args.cwd ?? process.cwd() });
						return { result: { session } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "prompt", (call) => {
						const args = (call.args ?? {}) as {
							session?: string;
							text?: string;
							mode?: "queue" | "steer";
							images?: PromptImage[];
						};
						if (args.session === undefined || args.text === undefined) {
							throw new Error("sessions.prompt needs a session and a text");
						}
						service.prompt(args.session, {
							text: args.text,
							...(args.mode === undefined ? {} : { mode: args.mode }),
							...(args.images === undefined ? {} : { images: args.images }),
						});
						return { result: { session: args.session, queued: true } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "abort", (call) => {
						const { session } = (call.args ?? {}) as { session?: string };
						if (session === undefined) throw new Error("sessions.abort needs a session");
						service.abort(session);
						return {};
					}),
				);
				registrations.push(
					wire.handle("sessions", "focus", (call) => {
						const { session } = (call.args ?? {}) as { session?: string };
						if (session === undefined) throw new Error("sessions.focus needs a session");
						service.focus(session);
						return {};
					}),
				);
				registrations.push(
					wire.handle("sessions", "delete", async (call) => {
						const { session } = (call.args ?? {}) as { session?: string };
						if (session === undefined) throw new Error("sessions.delete needs a session");
						return { result: { removed: await service.remove(session) } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "rename", async (call) => {
						const { session, title } = (call.args ?? {}) as { session?: string; title?: string };
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
						const { session, pinned } = (call.args ?? {}) as { session?: string; pinned?: boolean };
						if (session === undefined) throw new Error("sessions.pin needs a session");
						if (typeof pinned !== "boolean") throw new Error("sessions.pin needs pinned: true or false");
						await service.setMeta(session, { pinned });
						return { result: { session, pinned } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "archive", async (call) => {
						const { session, archived } = (call.args ?? {}) as { session?: string; archived?: boolean };
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
						const args = (call.args ?? {}) as {
							session?: string;
							entryId?: string;
							position?: "at" | "before";
							title?: string;
						};
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
						const { session, instructions } = (call.args ?? {}) as { session?: string; instructions?: string };
						if (session === undefined) throw new Error("sessions.compact needs a session");
						const compacted = await service.compact(session, instructions);
						return { result: { session, compacted } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "btwOpen", (call) => {
						const { session, kind } = (call.args ?? {}) as { session?: string; kind?: BtwThread["kind"] };
						if (session === undefined) throw new Error("sessions.btwOpen needs a session");
						if (kind !== "contextual" && kind !== "tangent") {
							throw new Error("sessions.btwOpen needs kind: contextual or tangent");
						}
						const thread = service.btwOpen(session, kind);
						return { result: { session, thread } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "btwAsk", async (call) => {
						const { session, threadId, question } = (call.args ?? {}) as {
							session?: string;
							threadId?: string;
							question?: string;
						};
						if (session === undefined || threadId === undefined || question === undefined) {
							throw new Error("sessions.btwAsk needs a session, a threadId and a question");
						}
						await service.btwAsk(session, threadId, question);
						return { result: { session, threadId } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "btwAnswer", (call) => {
						const { session, threadId, question, answer } = (call.args ?? {}) as {
							session?: string;
							threadId?: string;
							question?: string;
							answer?: string;
						};
						if (session === undefined || threadId === undefined || question === undefined) {
							throw new Error("sessions.btwAnswer needs a session, a threadId and a question");
						}
						service.btwAnswer(session, threadId, question, answer ?? "");
						return { result: { session, threadId } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "btwSave", async (call) => {
						const { session, threadId } = (call.args ?? {}) as { session?: string; threadId?: string };
						if (session === undefined || threadId === undefined) {
							throw new Error("sessions.btwSave needs a session and a threadId");
						}
						return { result: { state: await service.btwSave(session, threadId) } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "btwHandoff", (call) => {
						const { session, threadId } = (call.args ?? {}) as { session?: string; threadId?: string };
						if (session === undefined || threadId === undefined) {
							throw new Error("sessions.btwHandoff needs a session and a threadId");
						}
						return { result: { delivered: service.btwHandoff(session, threadId) } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "btwClear", (call) => {
						const { session, threadId } = (call.args ?? {}) as { session?: string; threadId?: string };
						if (session === undefined || threadId === undefined) {
							throw new Error("sessions.btwClear needs a session and a threadId");
						}
						return { result: { cleared: service.btwClear(session, threadId) } };
					}),
				);
				registrations.push(
					wire.handle("sessions", "resync", (call) => {
						// A resync is a read: it answers with the current state of one session's target.
						const { session } = (call.args ?? {}) as { session?: string };
						if (session === undefined) throw new Error("sessions.resync needs a session");
						const state =
							service.session(session) === undefined ? undefined : wire.snapshot(`sessions.${session}`);
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

function toImageContent(image: PromptImage): ImageContent {
	return { type: "image", mimeType: image.mime, data: image.dataBase64 } as ImageContent;
}
