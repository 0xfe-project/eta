/**
 * SessionManager — several sessions in one process (REFACTOR.md §5b).
 *
 * What it owns, and why each part is here rather than in the harness:
 *
 * - **Identity and metadata.** A session exists because the store has a row for
 *   it; the manager picks the id and keeps the row's metadata with the open
 *   session, so a list can be rendered without opening anything.
 * - **Which sessions are open right now.** Opening is a decision with a cost (a
 *   journal replay, a kernel, its services), so it happens once per session and
 *   the handle is reused until the session is closed.
 * - **Sessions do not share anything.** Each one is a separate `openSession` and
 *   its own cordis root: its own kernel, bus, journal, usage and task ledger. Two
 *   sessions in the same directory are still two sessions, and one cannot hear the
 *   other's events (cordis dispatches a tree's events tree-wide, so sharing a root
 *   is exactly how two sessions would start writing into each other's journal).
 *
 * The harness does the assembly; this layer decides *when* to assemble, and what
 * to do with the result. The model layer is injected as a factory because
 * resolving a provider is the application's business — the manager only needs to
 * hand `openSession` something that can generate.
 */
import type { CompactionSummarizer, KernelModels } from "@eta/core";
import { forkChain } from "@eta/core";
import { type OpenSession, openSession, type SubagentManager } from "@eta/harness";
import { forkWrites } from "./fork";
import type { SessionListing, SessionMeta, SessionStore } from "./store";
import { sessionSubagentRunner } from "./subagent";

/** A session the manager has open. */
export interface ManagedSession {
	meta: SessionMeta;
	session: OpenSession;
}

export interface SessionManagerOptions {
	store: SessionStore;
	/**
	 * The model layer for this session. Called once per open, with the metadata —
	 * so which provider and model a session uses is the application's decision,
	 * not the manager's.
	 */
	modelsFor: (meta: SessionMeta) => KernelModels | Promise<KernelModels>;
	/** The summarizer a session compacts with; without one, a session runs unbound. */
	compaction?: CompactionSummarizer | undefined;
	/**
	 * Whether a session can spawn subagents. On by default: a subagent is a session of its
	 * own here, so the capability costs nothing new to explain. `false` means the subagent
	 * tools are not installed at all — absent, not disabled.
	 */
	subagents?: { poolSize?: number | undefined } | false | undefined;
	/** What a new session's metadata starts as, beyond the id and the time. */
	defaults?: Partial<Pick<SessionMeta, "persona" | "model" | "title">> | undefined;
	/** Called when a session cannot be opened; the list keeps its row either way. */
	warn?: ((message: string) => void) | undefined;
}

/** What a caller supplies to branch a session off another one. */
export interface ForkSessionOptions {
	/** The entry to fork from; defaults to the source's tip. */
	entryId?: string | undefined;
	/** Whether the selected entry is part of the fork (default) or excluded. */
	position?: "before" | "at" | undefined;
	/** The destination's title; defaults to the source's, marked as a fork. */
	title?: string | undefined;
}

/** What a caller supplies to start a session. */
export interface CreateSessionOptions {
	/** The project the session works in. Defaults to the process's directory. */
	cwd?: string | undefined;
	title?: string | undefined;
	persona?: string | undefined;
	model?: string | undefined;
	/**
	 * The subagent record this session's own pool acts as. Omitted for a root session; a
	 * subagent passes its record id, which is what files a grandchild under it.
	 */
	subagentOwner?: string | undefined;
	/** A pool to join: set by a subagent, which belongs to the tree that spawned it. */
	subagents?: SubagentManager | undefined;
}

export class SessionManager {
	private readonly store: SessionStore;
	private readonly modelsFor: SessionManagerOptions["modelsFor"];
	private readonly compaction: CompactionSummarizer | undefined;
	private readonly defaults: SessionManagerOptions["defaults"];
	private readonly subagents: SessionManagerOptions["subagents"];
	private readonly warn: (message: string) => void;
	private readonly open = new Map<string, ManagedSession>();

	constructor(options: SessionManagerOptions) {
		this.store = options.store;
		this.modelsFor = options.modelsFor;
		this.compaction = options.compaction;
		this.subagents = options.subagents;
		this.defaults = options.defaults;
		this.warn = options.warn ?? (() => undefined);
	}

	/** Start a session and open it. */
	async create(options: CreateSessionOptions = {}): Promise<ManagedSession> {
		const meta: SessionMeta = {
			id: newSessionId(),
			createdAt: Date.now(),
			cwd: options.cwd ?? process.cwd(),
			...((options.title ?? this.defaults?.title) === undefined
				? {}
				: { title: (options.title ?? this.defaults?.title) as string }),
			...((options.persona ?? this.defaults?.persona) === undefined
				? {}
				: { persona: options.persona ?? this.defaults?.persona }),
			...((options.model ?? this.defaults?.model) === undefined
				? {}
				: { model: options.model ?? this.defaults?.model }),
		};
		await this.store.create(meta);
		return await this.openSession(meta, options.subagentOwner, options.subagents);
	}

	/**
	 * The session behind an id, opening it the first time it is asked for.
	 * `undefined` when the store has no such session; a session that is *there*
	 * but cannot be opened is an error, because that is a bug worth hearing about.
	 */
	async session(id: string): Promise<ManagedSession | undefined> {
		const already = this.open.get(id);
		if (already !== undefined) return already;
		const stored = await this.store.open(id);
		if (stored === undefined) return undefined;
		return await this.openSession(stored.meta);
	}

	/** Close a session: its journal is flushed, its services stopped, its slot freed. */
	async close(id: string): Promise<boolean> {
		const managed = this.open.get(id);
		if (managed === undefined) return false;
		this.open.delete(id);
		await this.disposeSession(managed);
		return true;
	}

	/** Every session the store knows about, newest first — including unreadable ones. */
	async list(): Promise<SessionListing[]> {
		return await this.store.list();
	}

	/**
	 * Change what a session's row says — its title, whether it is pinned, whether it is
	 * archived. `undefined` when there is no such session.
	 *
	 * Only the row moves: a running session keeps the model, tools and persona it is
	 * already running with, because a rename is not a reconfiguration.
	 */
	async setMeta(
		id: string,
		patch: Partial<Omit<SessionMeta, "id" | "createdAt" | "cwd">>,
	): Promise<SessionMeta | undefined> {
		const live = this.open.get(id);
		const current = live?.meta ?? (await this.store.open(id))?.meta;
		if (current === undefined) return undefined;
		const next: SessionMeta = { ...current, ...patch };
		if (!(await this.store.save(next))) return undefined;
		// Keep the open handle's copy honest: `list()` and every state projection read it.
		if (live !== undefined) live.meta = next;
		return next;
	}

	/**
	 * Branch a session off another one and open the result.
	 *
	 * The copied part is the source's history up to the chosen entry (the entry itself,
	 * or its parent) plus the lane configuration it was left on. A fork is a new
	 * session: it does not point back at the source, and it drops the source's task
	 * list — see `fork.ts` for why those two in particular.
	 */
	async fork(sourceId: string, options: ForkSessionOptions = {}): Promise<ManagedSession> {
		const source = await this.session(sourceId);
		if (source === undefined) throw new Error(`no such session: ${sourceId}`);
		const chain = forkChain(source.session.log.graph, {
			...(options.entryId === undefined ? {} : { entryId: options.entryId }),
			position: options.position ?? "at",
		});
		const meta: SessionMeta = {
			id: newSessionId(),
			createdAt: Date.now(),
			cwd: source.meta.cwd,
			title: options.title ?? titleForFork(source.meta.title),
			...(source.meta.persona === undefined ? {} : { persona: source.meta.persona }),
			...(source.meta.model === undefined ? {} : { model: source.meta.model }),
		};
		const created = await this.store.create(meta);
		await created.storage.commit(await forkWrites(source.session.log.storage, chain));
		return await this.openSession(meta);
	}

	/**
	 * Forget a session: close it if it is open, then take its row and its directory away.
	 * Closing first matters — deleting a journal out from under an open handle is a leak the
	 * runtime reports much later, far from here.
	 */
	async remove(id: string): Promise<boolean> {
		await this.close(id);
		return await this.store.remove(id);
	}

	/** The sessions that are open right now. */
	openSessions(): ManagedSession[] {
		return [...this.open.values()];
	}

	/** Close everything this manager opened. */
	async closeAll(): Promise<void> {
		const managed = [...this.open.values()];
		this.open.clear();
		for (const session of managed) await this.disposeSession(session);
	}

	private async openSession(
		meta: SessionMeta,
		subagentOwner?: string,
		joined?: SubagentManager,
	): Promise<ManagedSession> {
		const models = await this.modelsFor(meta);
		// The pool a session runs its children through. A child joins its tree's; a root is
		// given a runner and the pool is built around it during assembly — which is why the
		// runner reads the pool lazily, through this box.
		const box: { pool?: SubagentManager } = {};
		const poolSize = this.subagents === false ? undefined : this.subagents?.poolSize;
		const subagentOptions: Record<string, unknown> =
			joined !== undefined
				? { subagents: joined, ...(subagentOwner === undefined ? {} : { subagentOwner }) }
				: {
						subagentRunner: sessionSubagentRunner({
							manager: this,
							parent: meta,
							parentPool: () => box.pool,
							warn: this.warn,
						}),
						...(subagentOwner === undefined ? {} : { subagentOwner }),
						...(poolSize === undefined ? {} : { poolSize }),
					};
		const session = await openSession({
			storage: (await this.store.open(meta.id))!.storage,
			models,
			// Subagents: a session joins the pool of the tree that spawned it, or — when it is a
			// root — gets a runner, and the pool is built around it during assembly.
			...(this.subagents === false ? {} : subagentOptions),
			...(this.compaction === undefined ? {} : { compaction: this.compaction }),
			config: {
				...(meta.model === undefined ? {} : { model: splitModel(meta.model) }),
			},
			// No shared root: each session is its own cordis scope, so its bus,
			// journaling, usage and goals cannot hear another session's events.
			kernel: { warn: this.warn },
		});
		if (meta.persona !== undefined) session.kernel.persona.setActive([meta.persona]);
		box.pool = session.subagents;
		// A session the host opened is a session whose inbox becomes runs: the pump is what
		// decides that, and leaving it off would make "prompt a session nobody attached yet"
		// (a subagent's own run, a session from the store) quietly do nothing.
		session.pump.start();
		const managed: ManagedSession = { meta, session };
		this.open.set(meta.id, managed);
		return managed;
	}

	private async disposeSession(managed: ManagedSession): Promise<void> {
		// A closing session stops what it spawned: nothing is orphaned when the thing that was
		// going to read the answer is gone — the same rule the pool applies to a parent that
		// settles on its own.
		for (const record of managed.session.subagents?.list() ?? []) {
			if (record.status !== "running" && record.status !== "queued") continue;
			try {
				managed.session.subagents?.stop(record.id, undefined);
			} catch (error) {
				this.warn(`[eta-server] could not stop ${record.id}: ${String(error)}`);
			}
		}
		managed.session.pump.stop();
		try {
			await managed.session.journaling.flush();
		} catch (error) {
			this.warn(`[eta-server] could not flush ${managed.meta.id}: ${String(error)}`);
		}
		managed.session.stop();
		await managed.session.kernel.dispose();
	}
}

/** The title a fork gets when the caller did not choose one. */
function titleForFork(title: string | undefined): string {
	return title === undefined || title.length === 0 ? "forked session" : `${title} (fork)`;
}

/** A fresh session id in the shape the app has always used. */
export function newSessionId(): string {
	const random = Math.random().toString(36).slice(2, 8);
	return `eta-${Date.now().toString(36)}${random}`;
}

/** `provider:modelId` back into the two halves a session config takes. */
function splitModel(model: string): { provider: string; modelId: string } {
	const separator = model.indexOf(":");
	if (separator === -1) return { provider: model, modelId: model };
	return { provider: model.slice(0, separator), modelId: model.slice(separator + 1) };
}
