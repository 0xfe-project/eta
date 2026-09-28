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
 * - **Sessions do not share anything.** Each one is a separate `openSession`:
 *   its own kernel, bus, journal, usage and task ledger. Two sessions in the
 *   same directory are still two sessions.
 *
 * The harness does the assembly; this layer decides *when* to assemble, and what
 * to do with the result. The model layer is injected as a factory because
 * resolving a provider is the application's business — the manager only needs to
 * hand `openSession` something that can generate.
 */
import type { CompactionSummarizer, KernelModels } from "@eta/core";
import { type OpenSession, openSession } from "@eta/harness";
import type { SessionListing, SessionMeta, SessionStore } from "./store";

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
	/** What a new session's metadata starts as, beyond the id and the time. */
	defaults?: Partial<Pick<SessionMeta, "persona" | "model" | "title">> | undefined;
	/** Called when a session cannot be opened; the list keeps its row either way. */
	warn?: ((message: string) => void) | undefined;
}

/** What a caller supplies to start a session. */
export interface CreateSessionOptions {
	/** The project the session works in. Defaults to the process's directory. */
	cwd?: string | undefined;
	title?: string | undefined;
	persona?: string | undefined;
	model?: string | undefined;
}

export class SessionManager {
	private readonly store: SessionStore;
	private readonly modelsFor: SessionManagerOptions["modelsFor"];
	private readonly compaction: CompactionSummarizer | undefined;
	private readonly defaults: SessionManagerOptions["defaults"];
	private readonly warn: (message: string) => void;
	private readonly open = new Map<string, ManagedSession>();

	constructor(options: SessionManagerOptions) {
		this.store = options.store;
		this.modelsFor = options.modelsFor;
		this.compaction = options.compaction;
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
		return await this.openSession(meta);
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

	private async openSession(meta: SessionMeta): Promise<ManagedSession> {
		const models = await this.modelsFor(meta);
		const session = await openSession({
			storage: (await this.store.open(meta.id))!.storage,
			models,
			...(this.compaction === undefined ? {} : { compaction: this.compaction }),
			config: {
				...(meta.model === undefined ? {} : { model: splitModel(meta.model) }),
			},
			kernel: { warn: this.warn },
		});
		if (meta.persona !== undefined) session.kernel.persona.setActive([meta.persona]);
		const managed: ManagedSession = { meta, session };
		this.open.set(meta.id, managed);
		return managed;
	}

	private async disposeSession(managed: ManagedSession): Promise<void> {
		try {
			await managed.session.journaling.flush();
		} catch (error) {
			this.warn(`[eta-server] could not flush ${managed.meta.id}: ${String(error)}`);
		}
		managed.session.stop();
		await managed.session.kernel.dispose();
	}
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
