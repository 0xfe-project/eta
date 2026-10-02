/**
 * The `providers` plugin: `~/.eta/config.json` on the wire.
 *
 * It owns a target called `providers` with one section — the config as a client sees it (keys
 * become booleans, headers stay) plus the revision it was read at — and the actions that change
 * it. Every write carries the revision it read, so a settings page and an editor cannot silently
 * overwrite each other; a refused write comes back as `config_changed` and the client re-reads.
 *
 * The file is watched, and a change made *outside* this process pushes the new state to whoever
 * is subscribed. That is the whole of "reload": the config is read per turn by whoever needs it,
 * so a new provider takes effect on the next request without anything being restarted.
 *
 * Like every bundled plugin, it is only mounted by default: unmount it and `providers.*` becomes
 * "unknown op" while the rest of the server keeps running (sessions then run on whatever models
 * the host injected, or fail honestly with `model_unavailable`).
 */
import type { ProvidersView, ProviderArgs } from "@eta/client-contracts";
import { Service } from "cordis";
import { CodexCredentialStore, CodexLogin, codexAuthPath, piCodexLogin } from "../codex-auth";
import { discoverModels } from "../providers/discovery";
import type { ProviderConfigStore } from "../providers/store";
import type { WireService } from "../wire-service";

export { PROVIDER_ACTIONS } from "@eta/client-contracts";

export interface ProvidersPluginOptions {
	store: ProviderConfigStore;
	/** How long a codex login may stay pending. Zero-ish values are for tests. */
	loginTimeoutMs?: number | undefined;
	/**
	 * The HTTP client discovery uses. A test supplies one; production uses `fetch`, which is what
	 * makes the refresh path the same client the requests go through.
	 */
	fetch?: typeof fetch | undefined;
	/** Diagnostics. */
	warn?: ((message: string) => void) | undefined;
}

/**
 * The config as one state section. The revision lives *inside* the section rather than in the
 * section's revision: it is the config file's revision (what a write must carry), not a
 * signature of the projection, and the two would be confused the moment they shared a name.
 */
function section(view: ProvidersView): { sections: Record<string, unknown>; revisions: Record<string, string> } {
	return {
		sections: { config: view },
		// The section moves exactly when the file's revision does, which is what makes a push
		// after a change carry the new config and a push after nothing carry none.
		revisions: { config: view.revision },
	};
}

export function providersPlugin(options: ProvidersPluginOptions) {
	return {
		name: "providers",
		inject: ["wire"],
		apply(ctx: unknown): unknown {
			const context = ctx as {
				wire: WireService;
				effect(execute: () => () => unknown): unknown;
			};
			const wire = context.wire;
			// The codex login: a second target's worth of state, kept on this one because it is
			// about the same subject (which providers exist and whether they are usable). The
			// credentials live beside the config file, and the flow is pi-ai's.
			const credentials = new CodexCredentialStore(codexAuthPath(options.store.path));
			const codex = new CodexLogin({
				credentials,
				login: piCodexLogin(credentials),
				...(options.loginTimeoutMs === undefined ? {} : { timeoutMs: options.loginTimeoutMs }),
			});

			return context.effect(() => {
				// What the section shows: the last read, plus the revision a write must carry.
				// Kept as a box because the state projector must be synchronous while reading the
				// file is not — the read happens on every write and on every watch tick.
				let latest: ProvidersView | undefined;
				const refresh = async (): Promise<ProvidersView> => {
					const view = await options.store.view();
					latest = view;
					return view;
				};
				void refresh().then(
					() => wire.pushNow("providers"),
					(error: unknown) => options.warn?.(`[eta-server] providers: ${String(error)}`),
				);

				const registrations: (() => void)[] = [
					wire.stateOf("providers", {
						// Eager: a settings page that has to ask before it can draw is a settings page
						// that flickers.
						eager: true,
						// Before the first read lands there is no config to show, and saying "no
						// providers, revision ''" would be a fabrication a client could act on — it
						// would send that revision back and be refused. An empty snapshot says the
						// honest thing: nothing is known yet, and the push after the read fills it in.
						project: () => (latest === undefined ? { sections: {}, revisions: {} } : section(latest)),
					}),
					wire.handle("providers", "save", async (call) => {
						const args = (call.args ?? {}) as Partial<ProviderArgs["save"]>;
						if (args.provider === undefined) throw new Error("providers.save needs a provider");
						const view = await options.store.save({ revision: args.revision, provider: args.provider });
						latest = view;
						wire.pushNow("providers");
						return { result: { revision: view.revision } };
					}),
					wire.handle("providers", "delete", async (call) => {
						const args = (call.args ?? {}) as Partial<ProviderArgs["delete"]>;
						if (typeof args.id !== "string") throw new Error("providers.delete needs an id");
						const view = await options.store.delete(args.id, args.revision);
						latest = view;
						wire.pushNow("providers");
						return { result: { revision: view.revision } };
					}),
					wire.handle("providers", "setDefault", async (call) => {
						const args = (call.args ?? {}) as Partial<ProviderArgs["setDefault"]>;
						const view = await options.store.setDefault(args.defaultModel ?? null, args.revision);
						latest = view;
						wire.pushNow("providers");
						return { result: { revision: view.revision, defaultModel: view.defaultModel ?? null } };
					}),
					wire.handle("providers", "setNetwork", async (call) => {
						const args = (call.args ?? {}) as Partial<ProviderArgs["setNetwork"]>;
						if (typeof args.mode !== "string") throw new Error("providers.setNetwork needs a mode");
						const view = await options.store.setNetwork(
							{
								mode: args.mode,
								...(args.proxyUrl === undefined ? {} : { proxyUrl: args.proxyUrl }),
								...(args.noProxy === undefined ? {} : { noProxy: args.noProxy }),
							},
							args.revision,
						);
						latest = view;
						wire.pushNow("providers");
						return { result: { revision: view.revision, network: view.network ?? null } };
					}),
					wire.handle("providers", "refresh", async (call) => {
						const { id } = (call.args ?? {}) as Partial<ProviderArgs["refresh"]>;
						if (id === undefined) throw new Error("providers.refresh needs an id");
						const view = await options.store.view();
						const provider = (view.providers ?? []).find((entry) => entry.id === id);
						if (provider === undefined) throw new Error(`no such provider: ${id}`);
						const discovered = await discoverModels({
							reference: { kind: provider.kind, baseUrl: provider.baseUrl },
							headers: provider.headers,
							...(options.fetch === undefined ? {} : { fetch: options.fetch }),
						});
						if (discovered.error !== undefined) throw new Error(discovered.error);
						// The refresh writes what it found, at the revision it read: a config that
						// changed while the request was in flight is refused rather than overwritten
						// with a list that is already stale.
						const updated = await options.store.markRefreshed(id, discovered.models, new Date().toISOString());
						latest = updated ?? (await refresh());
						wire.pushNow("providers");
						return { result: { revision: latest.revision, models: discovered.models.length } };
					}),
					wire.handle("providers", "codexLogin", (call) => {
						const { method } = (call.args ?? {}) as Partial<ProviderArgs["codexLogin"]>;
						if (method !== undefined && method !== "browser" && method !== "device_code") {
							throw new Error("providers.codexLogin needs method: browser or device_code");
						}
						// The view carries no token: it is what a UI renders and what the wire carries.
						return { result: { login: codex.start(method ?? "browser") } };
					}),
					wire.handle("providers", "codexAnswer", (call) => {
						const { id, promptId, value } = (call.args ?? {}) as Partial<ProviderArgs["codexAnswer"]>;
						if (id === undefined || promptId === undefined || value === undefined) {
							throw new Error("providers.codexAnswer needs an id, a promptId and a value");
						}
						const accepted = codex.answer(id, promptId, value);
						if (!accepted) throw new Error("codex_login_failed: that prompt is not waiting");
						return { result: { accepted } };
					}),
					wire.handle("providers", "codexStatus", (call) => {
						const { id } = (call.args ?? {}) as Partial<ProviderArgs["codexStatus"]>;
						if (id === undefined) throw new Error("providers.codexStatus needs an id");
						return { result: { login: codex.status(id) } };
					}),
					wire.handle("providers", "codexCancel", (call) => {
						const { id } = (call.args ?? {}) as Partial<ProviderArgs["codexCancel"]>;
						codex.cancel(id);
						return { result: { cancelled: true, ...(id === undefined ? {} : { login: codex.status(id) }) } };
					}),
					wire.handle("providers", "reload", async () => {
						// A client asking "did anything change?" — the answer is the state, and the
						// revision in it is what says whether anything did.
						const view = await refresh();
						wire.pushNow("providers");
						return { result: { revision: view.revision } };
					}),
				];

				// A change made outside this process (an editor, another tool) reaches subscribers
				// the same way a change made through an action does: the state moved. Starting the
				// watch without saying who to tell is a watch nobody hears — which is what this
				// was until the test that writes the file directly failed.
				options.store.watch((view) => {
					latest = view;
					wire.pushNow("providers");
				});
				const stopWatching = (): void => options.store.stop();
				return () => {
					for (const off of registrations.splice(0)) off();
					stopWatching();
				};
			});
		},
	};
}

/** The service shape other plugins can inject (`ctx.providers`) — the store, by name. */
export class ProvidersService extends Service {
	static readonly provide = "providers";

	readonly store: ProviderConfigStore;

	constructor(ctx: ConstructorParameters<typeof Service>[0], store: ProviderConfigStore) {
		super(ctx, "providers");
		this.store = store;
	}
}
