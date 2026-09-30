/**
 * The `git` plugin: a checkout's branch and dirty state, as a fact about a session.
 *
 * This is the plugin the whole plugin mechanism is measured against, because of what it is *not*:
 * it is not part of the server, it is not part of the sessions plugin, and it holds no session. It
 * listens for sessions appearing and changing, reads each one's working directory, and puts what it
 * found on a target of its own. Take it away and the server is exactly as good: the sidebar has no
 * branch badge, and nothing else changes.
 *
 * What it never does:
 *
 * - **Run git on a session that has not changed.** A status is a subprocess per session; the
 *   plugin recomputes on the bus events that can move the answer (a session opening, its run
 *   ending, its directory changing) and on demand, never on a timer.
 * - **Block anything.** The work is asynchronous and the state projector is synchronous: the
 *   section shows the last answer, and a session with no answer yet simply has no row.
 * - **Claim another plugin's name.** Everything it registers lives under `git` — the namespace rule
 *   would refuse it otherwise, which is the point of having the rule.
 */
import type { StateSnapshot } from "@eta/client-wire-proto";
import { type GitDiffKind, gitDiff, gitStatus } from "./git";

/** What the `sessions` plugin announces; this plugin's whole view of the session space. */
export interface SessionsListener {
	opened(session: { id: string; cwd: string }): void;
	closed(id: string): void;
	focused(id: string | undefined): void;
	changed(session: { id: string; cwd: string }): void;
}

/**
 * What this plugin needs from the shell: the `wire` service, structurally.
 *
 * Deliberately not `import type { WireService } from "@eta/server"`: a plugin's contract with the
 * floor is the four things below, and depending on the server package to name them would make a
 * plugin depend on the shell's internals — which is the line this architecture draws (plugins
 * depend on the harness; the floor gives them the wire).
 */
interface Wire {
	handle(target: string, action: string, handler: (call: { args?: unknown }) => unknown): () => void;
	stateOf(target: string, projector: { project(): StateSnapshot; eager?: boolean }): () => void;
	push(target: string): void;
	pushNow(target: string): void;
}

/** The actions this target has. One list, so the wire and the plugin cannot disagree. */
export const GIT_ACTIONS = ["status", "diff", "refresh"] as const;

/** What one session's checkout looks like, as the wire carries it. */
export interface GitFacts {
	session: string;
	cwd: string;
	notGit: boolean;
	branch: string | null;
	/** How many files are in each group — the badge a sidebar shows. */
	dirty: number;
	staged: number;
	untracked: number;
	conflicted: number;
	/** When this was read, so a client can tell a fact from a memory. */
	at: number;
}

export interface GitPluginOptions {
	/** Diagnostics. */
	warn?: ((message: string) => void) | undefined;
}

/**
 * The plugin.
 *
 * An object whose `apply` runs once per load, and whose state lives *inside* `apply`: the facts it
 * has read and the reads in flight are created fresh on every load, which is what makes a hot
 * reload safe. Module-level state would survive a reload with the previous instance still in it —
 * the "two of everything" failure a reload must not have.
 *
 * It injects `wire` (how it answers about checkouts) and `sessions` (how it hears about sessions).
 * Both by name: the sessions service is another plugin's, and reaching it any other way would mean
 * holding the session manager, which is exactly what a plugin must not do.
 */
export const gitPlugin = {
	name: "git",
	inject: ["wire", "sessions"],
	apply(ctx: unknown): unknown {
		const context = ctx as {
			wire: Wire;
			sessions: { subscribe(listener: SessionsListener): () => void };
			effect(execute: () => () => unknown): unknown;
			/** The host's diagnostics channel, when it has one. */
			warn?: ((message: string) => void) | undefined;
		};

		return context.effect(() => {
			/** What the plugin knows, keyed by session: the last read, which is what state shows. */
			const facts = new Map<string, GitFacts>();
			/** Reads in flight, so a burst of events does not spawn a dozen `git status` processes. */
			const reading = new Map<string, Promise<void>>();

			const read = async (session: string, cwd: string): Promise<void> => {
				const running = reading.get(session);
				if (running !== undefined) return await running;
				const work = (async () => {
					try {
						const status = await gitStatus(cwd);
						facts.set(session, {
							session,
							cwd,
							notGit: status.notGit,
							branch: status.branch,
							dirty: status.groups.changes.length,
							staged: status.groups.staged.length,
							untracked: status.groups.untracked.length,
							conflicted: status.groups.conflicted.length,
							at: Date.now(),
						});
					} catch (error) {
						context.warn?.(`[eta-git] could not read ${cwd}: ${String(error)}`);
					} finally {
						reading.delete(session);
					}
				})();
				reading.set(session, work);
				await work;
			};

			const push = (immediate: boolean): void => {
				if (immediate) context.wire.pushNow("git");
				else context.wire.push("git");
			};

			const registrations: (() => void)[] = [
				context.wire.stateOf("git", { project: () => section(facts), eager: true }),
				context.wire.handle("git", "status", async (call) => {
					const { session, cwd } = (call.args ?? {}) as { session?: string; cwd?: string };
					if (session === undefined || cwd === undefined) {
						throw new Error("git.status needs a session and its cwd");
					}
					await read(session, cwd);
					return { result: { facts: facts.get(session) ?? null } };
				}),
				context.wire.handle("git", "diff", async (call) => {
					const { cwd, path, kind } = (call.args ?? {}) as { cwd?: string; path?: string; kind?: GitDiffKind };
					if (cwd === undefined || path === undefined) throw new Error("git.diff needs a cwd and a path");
					const diff = await gitDiff(cwd, path, kind ?? "worktree");
					return { result: { diff: diff ?? null } };
				}),
				context.wire.handle("git", "refresh", async (call) => {
					const { session, cwd } = (call.args ?? {}) as { session?: string; cwd?: string };
					if (session === undefined || cwd === undefined) {
						throw new Error("git.refresh needs a session and its cwd");
					}
					// A user asked: read now, and do not wait out the budget.
					await read(session, cwd);
					push(true);
					return { result: { facts: facts.get(session) ?? null } };
				}),
			];

			// The sessions themselves: a checkout is read when a session appears and when one
			// moves, never on a timer. A run ending is the event that matters — it is when a
			// session is most likely to have changed the files it was working on.
			const unsubscribe = context.sessions.subscribe({
				opened: (session) => {
					void read(session.id, session.cwd).then(() => push(false));
				},
				changed: (session) => {
					void read(session.id, session.cwd).then(() => push(true));
				},
				focused: () => undefined,
				closed: (id) => {
					if (!facts.delete(id)) return;
					push(true);
				},
			});

			return () => {
				unsubscribe();
				for (const off of registrations.splice(0)) off();
			};
		});
	},
};

/** One section of the plugin's state: what it knows, in a stable order. */
function section(facts: Map<string, GitFacts>): StateSnapshot {
	const entries = [...facts.values()].sort((left, right) => left.session.localeCompare(right.session));
	return {
		sections: { sessions: entries },
		// Cheap on purpose: the ids and the things a badge shows. A read that changed nothing about
		// one session must not make the next frame carry all of them again.
		revisions: {
			sessions: entries
				.map(
					(entry) =>
						`${entry.session}:${entry.branch}:${entry.dirty}:${entry.staged}:${entry.untracked}:${entry.conflicted}`,
				)
				.join("|"),
		},
	};
}
