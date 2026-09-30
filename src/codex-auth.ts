/**
 * The codex auth kit: a credential store on disk, and a login you can watch.
 *
 * Two halves, and they are separate on purpose.
 *
 * **The store** is what the model layer reads: pi-ai's `CredentialStore`, backed by one file
 * (`~/.eta/codex-auth.json`). It is the only place a token lives, and the rules about writing it
 * are the usual ones — a directory only the user can read, a file only the user can read, written
 * to a temporary name and renamed, and a lock so two processes cannot lose each other's refresh.
 * The lock is implemented here rather than taken as a dependency: it is a create-with-`wx` file and
 * a stale check, and that is the whole of what this needs.
 *
 * **The login** is what a person watches. OAuth under a desktop shell is a flow with two shapes —
 * open a browser and wait, or show a device code and wait — and a bounded one: an attempt that
 * nobody finishes in fifteen minutes is a failed attempt, not a pending one forever. The state it
 * reports is deliberately *public*: an id, a status, a URL, a user code, and the id of a prompt
 * waiting for an answer. **No token is ever in it**, because it is rendered in a UI and sent over
 * the wire.
 *
 * The state machine takes its login runner as an argument, which is what makes it testable: the
 * flow itself is pi-ai's (a network), and what is tested here is everything around it — which
 * attempt is live, whether an answer belongs to it, and what a cancel leaves behind.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/** What a client is told about a login attempt. Never contains a token. */
export interface CodexLoginView {
	id: string;
	status: "pending" | "complete" | "failed" | "cancelled";
	method?: "browser" | "device_code";
	/** Set while the flow is waiting for a code the user types back. */
	manualPromptId?: string;
	/** The device code the user types at the verification URL. */
	userCode?: string;
	url?: string;
}

/** How the flow actually runs: given the interaction callbacks, do the OAuth dance. */
export type CodexLoginRunner = (interaction: {
	signal: AbortSignal;
	prompt(prompt: {
		type: string;
		options?: readonly { id: string; label: string }[];
		signal?: AbortSignal;
	}): Promise<string>;
	notify(event: { type: string; url?: string; userCode?: string; verificationUri?: string }): void;
}) => Promise<unknown>;

/**
 * The codex provider id, and the OAuth flow pi-ai ships for it.
 *
 * Kept behind a function so the module can be imported (and the state machine tested) without
 * pulling in a provider's network stack.
 */
export const CODEX_PROVIDER_ID = "openai-codex";

/**
 * The default runner: pi-ai's own OAuth login, through a `Models` collection holding only the
 * codex provider and backed by the credential store pi-ai will write to.
 */
export function piCodexLogin(credentials: CredentialStore): CodexLoginRunner {
	return async (interaction) => {
		const [{ createModels }, { codexRuntimeProvider }, { registerBunOAuthFlows }] = await Promise.all([
			import("@earendil-works/pi-ai"),
			import("./codex-provider"),
			import("@earendil-works/pi-ai/bun-oauth"),
		]);
		// The OAuth flows statically embedded in the runtime, so a bundled binary does not depend on
		// a dynamic import landing at the right path. Harmless when they are already registered.
		registerBunOAuthFlows();
		const models = createModels({ credentials });
		models.setProvider(codexRuntimeProvider());
		await models.login(CODEX_PROVIDER_ID, "oauth", interaction as never);
	};
}

/** Where the credentials live, beside the config that names the provider. */
export function codexAuthPath(configPath: string): string {
	return join(dirname(configPath), "codex-auth.json");
}

/** How long a login attempt may stay pending before it is given up on. */
export const LOGIN_TIMEOUT_MS = 15 * 60_000;

/** How long a lock file may sit there before it is assumed to be from a dead process. */
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 10_000;

/**
 * Run something with an exclusive lock on a path.
 *
 * `open(path, "wx")` is the primitive: creating the file *is* taking the lock, and it fails for
 * everyone else. A lock left behind by a process that died is broken after a minute — the
 * alternative is a stale lock that nobody can clear without knowing where to look.
 */
async function withLock<T>(path: string, run: () => Promise<T>): Promise<T> {
	const lockPath = `${path}.lock`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			const handle = await open(lockPath, "wx", 0o600);
			await handle.close();
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const info = await stat(lockPath).catch(() => undefined);
			if (info !== undefined && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
				await rm(lockPath, { force: true });
				continue;
			}
			if (Date.now() > deadline) throw new Error("codex_auth_locked");
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	try {
		return await run();
	} finally {
		await rm(lockPath, { force: true });
	}
}

/**
 * The credential store pi-ai reads.
 *
 * One file, keyed by provider id, holding whatever pi-ai put there. A file that does not parse is
 * an error rather than an empty store: "your credentials are corrupt" and "you have never logged
 * in" are different situations, and the second one is what a silent `{}` would report for both.
 */
export class CodexCredentialStore implements CredentialStore {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	private async load(): Promise<Record<string, Credential>> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
			return parsed as Record<string, Credential>;
		} catch {
			throw new Error("codex_credentials_invalid");
		}
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		return (await this.load())[providerId];
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		return Object.entries(await this.load()).map(([providerId, value]) => ({ providerId, type: value.type }));
	}

	/**
	 * The only write path, serialised under a lock: pi-ai runs an OAuth refresh inside `modify`, so
	 * two processes refreshing at once would otherwise rotate the token twice and lose one.
	 */
	async modify(
		providerId: string,
		update: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return await withLock(this.path, async () => {
			options?.signal?.throwIfAborted();
			const data = await this.load();
			const next = await update(data[providerId]);
			if (next !== undefined) data[providerId] = next;
			await this.write(data);
			return next;
		});
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		await withLock(this.path, async () => {
			options?.signal?.throwIfAborted();
			const data = await this.load();
			delete data[providerId];
			await this.write(data);
		});
	}

	/** Atomically, with permissions that assume a token is in there (because one is). */
	private async write(data: Record<string, Credential>): Promise<void> {
		// `0o700`: the directory's own permissions are part of the promise — a readable directory
		// makes a readable file a smaller step.
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify(data), { mode: 0o600, flag: "wx" });
			await rename(temporary, this.path);
		} finally {
			await rm(temporary, { force: true });
		}
	}
}

/**
 * One login attempt at a time, with a public state a client can watch.
 *
 * Every rule here exists because the alternative leaves something stuck:
 *
 * - **A new start cancels the attempt before it.** Two live attempts would mean a token from one
 *   and a prompt id from the other, and the user cannot tell which is which.
 * - **The attempt expires.** A flow nobody finishes is `cancelled`, not `pending` forever; the
 *   timer is unref'd so a pending login is not a reason to keep the process alive.
 * - **An answer belongs to an attempt and to a prompt.** `answer(id, promptId, value)` is refused
 *   when either does not match — the id alone would let a stale UI answer a new flow's prompt.
 * - **A cancel settles the attempt.** Its prompt rejects (through the same abort signal pi-ai
 *   watches), and a late `answer` does nothing.
 */
export class CodexLogin {
	private readonly store: CredentialStore;
	private readonly run: CodexLoginRunner;
	private readonly timeoutMs: number;
	private current: Attempt | undefined;
	/**
	 * How the last few attempts ended, by id.
	 *
	 * A client polls the id it started, and it may poll once more after cancelling — so a settled
	 * attempt has to stay readable for a moment. Bounded, because "the last few" is all a UI can
	 * hold; an id that fell off the end reports `failed`, which is honest (this process no longer
	 * knows anything about it).
	 */
	private readonly settled = new Map<string, CodexLoginView>();

	constructor(options: { credentials: CredentialStore; login: CodexLoginRunner; timeoutMs?: number }) {
		this.store = options.credentials;
		this.run = options.login;
		this.timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
	}

	/** Begin an attempt, cancelling any previous one. */
	start(method: "browser" | "device_code" = "browser"): CodexLoginView {
		this.cancel();
		const controller = new AbortController();
		const id = randomUUID();
		const timer = setTimeout(() => {
			// An attempt nobody finishes is given up on, not pending forever.
			if (this.current?.id === id) this.cancel(id);
		}, this.timeoutMs);
		(timer as { unref?: () => void }).unref?.();
		const attempt: Attempt = { id, controller, view: { id, status: "pending", method }, timer };
		this.current = attempt;

		void this.run({
			signal: controller.signal,
			prompt: async (prompt) => {
				// The method choice is answered here rather than asked of the user: this attempt
				// already knows which one it is.
				if (prompt.type === "select" && prompt.options?.some((option) => option.id === method) === true) {
					return method;
				}
				if (prompt.type !== "manual_code" || this.current?.id !== id) throw new Error("unsupported_prompt");
				const promptId = randomUUID();
				const signal =
					prompt.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, prompt.signal]);
				return await new Promise<string>((resolve, reject) => {
					const abort = (): void => {
						cleanup();
						reject(new Error("Login cancelled"));
					};
					const cleanup = (): void => {
						signal.removeEventListener("abort", abort);
						// Only *this* prompt's waiting slot is cleared: a newer attempt's is not ours.
						const live = this.current;
						if (live?.id !== id || live.answer?.promptId !== promptId) return;
						live.answer = undefined;
						const { manualPromptId: _settled, ...rest } = live.view;
						live.view = rest;
					};
					if (signal.aborted) {
						abort();
						return;
					}
					// The public state says which prompt is waiting, which is what makes an answer
					// checkable: an id alone would let a stale UI answer a new flow's prompt.
					attempt.view = { ...attempt.view, manualPromptId: promptId };
					attempt.answer = {
						promptId,
						settle: (value: string) => {
							cleanup();
							resolve(value);
						},
					};
					signal.addEventListener("abort", abort, { once: true });
				});
			},
			notify: (event) => {
				if (this.current?.id !== id) return;
				if (event.type === "device_code" && event.userCode !== undefined) {
					this.current.view = {
						...this.current.view,
						userCode: event.userCode,
						...(event.verificationUri === undefined ? {} : { url: event.verificationUri }),
					};
				}
				if (event.type === "auth_url" && event.url !== undefined) {
					this.current.view = { ...this.current.view, url: event.url };
				}
			},
		}).then(
			() => this.finish(id, "complete"),
			() => this.finish(id, "failed"),
		);
		return { ...attempt.view };
	}

	/** Answer the prompt this attempt is waiting on. `false` when it is not waiting on that one. */
	answer(id: string, promptId: string, value: string): boolean {
		const live = this.current;
		if (live?.id !== id || live.answer?.promptId !== promptId) return false;
		live.answer.settle(value);
		return true;
	}

	/** What an attempt is doing. An id this process does not know is `failed`, not a fake `pending`. */
	status(id: string): CodexLoginView {
		if (this.current?.id === id) return { ...this.current.view };
		const settled = this.settled.get(id);
		return settled === undefined ? { id, status: "failed" } : { ...settled };
	}

	/** Give up on an attempt (the current one, or a specific id). Idempotent. */
	cancel(id?: string): void {
		const attempt = this.current;
		if (attempt === undefined) return;
		if (id !== undefined && id !== attempt.id) return;
		attempt.controller.abort();
		clearTimeout(attempt.timer);
		this.current = undefined;
		// `cancelled`, not `failed`: a user who pressed cancel should not be told the login failed —
		// and what the attempt had already shown (a URL, a device code) stays readable.
		this.settle({ ...attempt.view, status: "cancelled" });
	}

	/** The credential store this login writes to, for a host that needs to hand it elsewhere. */
	get credentials(): CredentialStore {
		return this.store;
	}

	private finish(id: string, status: "complete" | "failed"): void {
		const attempt = this.current;
		if (attempt?.id !== id) return;
		this.current = undefined;
		clearTimeout(attempt.timer);
		this.settle({ ...attempt.view, status });
	}

	private settle(view: CodexLoginView): void {
		this.settled.set(view.id, view);
		// A bounded history: a UI polls the attempt it started, and maybe once after cancelling.
		if (this.settled.size > 8) {
			const oldest = this.settled.keys().next();
			if (oldest.done !== true) this.settled.delete(oldest.value);
		}
	}
}

/** One attempt, as this process holds it: the abort, the view, and the prompt waiting for an answer. */
interface Attempt {
	id: string;
	controller: AbortController;
	view: CodexLoginView;
	timer: ReturnType<typeof setTimeout>;
	answer?: { promptId: string; settle(value: string): void } | undefined;
}
