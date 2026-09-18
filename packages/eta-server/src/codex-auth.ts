import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { createModels, type Credential, type CredentialStore, type AuthOperationOptions } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { type CodexLoginView, type EtaModelConfig } from "@eta/core/provider-config";
import { providerModelCatalog } from "./provider-model-catalog.ts";

// pi supplies static OAuth loaders for the bundled desktop server.
registerBunOAuthFlows();

/** Persistent CredentialStore for pi Models; pi owns login and token refresh. */
export class CodexCredentialStore implements CredentialStore {
	readonly path: string;
	constructor(path: string) { this.path = path; }
	private async load(): Promise<Record<string, Credential>> {
		try {
			const data = JSON.parse(await readFile(this.path, "utf8"));
			if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
			return data;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw new Error("codex_credentials_invalid");
		}
	}
	async read(id: string, options?: AuthOperationOptions) { options?.signal?.throwIfAborted(); return (await this.load())[id]; }
	async list() { return Object.entries(await this.load()).map(([providerId, value]) => ({ providerId, type: value.type })); }
	private async write<T>(update: (data: Record<string, Credential>) => Promise<T>, options?: AuthOperationOptions): Promise<T> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		let compromised: Error | undefined;
		const release = await lockfile.lock(this.path, { realpath: false, onCompromised: error => { compromised = error; }, stale: 60_000, retries: { retries: 8, minTimeout: 100, maxTimeout: 1000 } });
		const temp = `${this.path}.${randomUUID()}.tmp`;
		try {
			options?.signal?.throwIfAborted();
			const data = await this.load();
			const result = await update(data);
			if (compromised) throw compromised;
			options?.signal?.throwIfAborted();
			await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
			await rename(temp, this.path);
			return result;
		} finally { await rm(temp, { force: true }); await release(); }
	}
	modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions) {
		return this.write(async data => { const next = await fn(data[id]); if (next !== undefined) data[id] = next; return data[id]; }, options);
	}
	delete(id: string, options?: AuthOperationOptions) { return this.write(async data => { delete data[id]; }, options); }
}

export const codexAuthPath = (configPath: string) => join(dirname(configPath), "auth.json");
/** Keep pi's provider intact, restricting only the user's selected catalog. */
export function codexRuntimeProvider(configured?: EtaModelConfig[]) {
	const provider = openaiCodexProvider();
	if (configured === undefined) return provider;
	const selected = new Set(configured.map(model => model.id));
	return { ...provider, getModels: () => provider.getModels().filter(model => selected.has(model.id)) };
}

export function codexCatalog(): EtaModelConfig[] {
	return providerModelCatalog({ kind: "openai-codex", baseUrl: "https://chatgpt.com/backend-api" });
}

/** A bounded, cancellable pi OAuth login. Public state contains no access/refresh tokens. */
export class CodexLogin {
	private attempt?: { id: string; providerId: string; controller: AbortController; view: CodexLoginView; timer: ReturnType<typeof setTimeout>; answer?: (value: string) => void };
	private credentials: CredentialStore;
	constructor(credentials: CredentialStore) { this.credentials = credentials; }
	start(providerId: string, method: "browser" | "device_code" = "browser"): CodexLoginView {
		this.cancel();
		const controller = new AbortController();
		const id = randomUUID();
		const view: CodexLoginView = { id, status: "pending", method };
		const timer = setTimeout(() => { if (this.attempt?.id === id) this.cancel(); }, 15 * 60_000);
		timer.unref?.();
		this.attempt = { id, providerId, controller, view, timer };
		const models = createModels({ credentials: this.credentials });
		models.setProvider(codexRuntimeProvider());
		void models.login(providerId, "oauth", {
			signal: controller.signal,
			prompt: async prompt => {
				if (prompt.type === "select" && prompt.options.some(option => option.id === method)) return method;
				if (prompt.type !== "manual_code" || this.attempt?.id !== id) throw new Error("unsupported_prompt");
				const promptId = randomUUID();
				const signal = AbortSignal.any([controller.signal, ...(prompt.signal ? [prompt.signal] : [])]);
				return new Promise<string>((resolve, reject) => {
					const abort = () => { cleanup(); reject(new Error("Login cancelled")); };
					const cleanup = () => {
						signal.removeEventListener("abort", abort);
						if (this.attempt?.id === id && this.attempt.view.manualPromptId === promptId) {
							delete this.attempt.answer; delete this.attempt.view.manualPromptId;
						}
					};
					if (signal.aborted) { abort(); return; }
					this.attempt!.view = { ...this.attempt!.view, manualPromptId: promptId };
					this.attempt!.answer = value => { cleanup(); resolve(value); };
					signal.addEventListener("abort", abort, { once: true });
				});
			},
			notify: event => {
				if (this.attempt?.id !== id) return;
				if (event.type === "device_code") this.attempt.view = { ...this.attempt.view, userCode: event.userCode, url: event.verificationUri };
				if (event.type === "auth_url") this.attempt.view = { ...this.attempt.view, url: event.url };
			},
		}).then(() => { if (this.attempt?.id === id) this.attempt.view = { id, status: "complete" }; })
			.catch(() => { if (this.attempt?.id === id) this.attempt.view = { id, status: "failed" }; });
		return view;
	}
	answer(id: string, promptId: string, value: string): boolean {
		if (this.attempt?.id !== id || this.attempt.view.manualPromptId !== promptId || !this.attempt.answer) return false;
		this.attempt.answer(value);
		return true;
	}

	status(id: string): CodexLoginView { return this.attempt?.id === id ? this.attempt.view : { id, status: "failed" }; }
	cancel(id?: string) { if (this.attempt && (id === undefined || id === this.attempt.id)) { this.attempt.controller.abort(); clearTimeout(this.attempt.timer); this.attempt = undefined; } }
}
