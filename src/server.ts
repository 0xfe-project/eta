/**
 * The whole floor, assembled.
 *
 * Everything below this file is a part: the transport knows sockets, the registry knows
 * `target.action`, the state sender decides frames, the pacer decides when, the manager owns
 * sessions, the store owns durability. This is the one place they are put together — and the
 * shape of the assembly is the point of the refactor: **the shell is a pipe plus a plugin
 * manager, and every feature is a plugin.**
 *
 * So what is here is short on purpose:
 *
 * 1. one cordis context;
 * 2. the `wire` service on it (the seam plugins register against);
 * 3. the model layer, built from the providers config;
 * 4. the session manager, which needs that model layer and the settings;
 * 5. the bundled plugins, each mounted like any other;
 * 6. the transport, last, because it is what turns frames into sockets.
 *
 * Nothing here knows what `sessions.create` does. Take the `sessions` plugin away and the server
 * still starts, still serves, still answers `hello` — with one fewer target. That is the test
 * that the floor is a floor and not a session host with plugins bolted on.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MountedPlugin } from "@eta/client-contracts";
import type { CompactionSummarizer, KernelModels } from "@eta/core";
import { Context } from "cordis";
import { personasPlugin } from "./bundled/personas";
import { providersPlugin } from "./bundled/providers";
import { sessionsPlugin } from "./bundled/sessions";
import { settingsPlugin } from "./bundled/settings";
import { FileSessionStore } from "./file-store";
import { SessionManager, type SessionManagerOptions } from "./manager";
import { parseModelId } from "./model-id";
import { initializeNetwork } from "./network";
import { discoverPersonas } from "./personas";
import { PluginManager } from "./plugins";
import type { EtaProviderConfig } from "./providers/config-types";
import { buildModels } from "./providers/runtime";
import { defaultConfigPath, ProviderConfigStore } from "./providers/store";
import { messageText } from "./search";
import { SettingsStore, settingsPath } from "./settings";
import { renderSkillsBlock } from "./skills";
import { serveWire, type WireServer } from "./transport";
import { WireService } from "./wire-service";

export interface AssembleOptions {
	/** Where sessions live: one directory each. */
	dataDir: string;
	/** The providers config file. Defaults to `~/.eta/config.json`. */
	configPath?: string;
	/** The port to listen on. Zero means "any free one". */
	port?: number;
	/**
	 * Whether to apply the config's network settings to the environment at startup. `false` leaves
	 * the environment exactly as the process was started with — what a test wants, and what a
	 * caller that manages its own proxy wants.
	 */
	network?: boolean | undefined;
	/** The summarizer sessions compact with. Without one they run unbound. */
	compaction?: CompactionSummarizer;
	/**
	 * The model layer, when the host has one of its own (a test with scripted answers, an
	 * embedding that builds providers differently). Omitted, it is built from the providers
	 * config — which is what a normal start does.
	 */
	models?: KernelModels | undefined;
	/** Which bundled plugins to mount. Default: all of them. */
	plugins?: readonly BundledPluginName[];
	/** How often to check the user's plugin directory for edits. Zero disables watching. */
	pluginWatchIntervalMs?: number | undefined;
	/** The agent's home, for `~/.eta/persona`. Defaults to the real one. */
	home?: string | undefined;
	/**
	 * How a session's environment is decided — the file and shell tools it runs, and where its
	 * memory lives. Passed straight to the manager; the server itself never builds one.
	 */
	envFor?: SessionManagerOptions["envFor"] | undefined;
	warn?: ((message: string) => void) | undefined;
}

export type BundledPluginName = "sessions" | "providers" | "settings" | "personas";

/** The plugin directories, as the layout in SERVER-REFACTOR.md §10 names them. */
export function pluginDirs(dataDir: string): { modules: string; plugins: string } {
	return { modules: join(dataDir, "modules"), plugins: join(dataDir, "plugins") };
}

export interface AssembledServer {
	readonly ctx: Context;
	readonly wire: WireService;
	readonly sessions: SessionManager;
	readonly server: WireServer;
	/** The scanned plugins: what is loaded, and what became of the ones that are not. */
	readonly manager: PluginManager;
	/** Every plugin mounted, and whatever stopped it. */
	mounted(): MountedPlugin[];
	/** Stop listening, close the sessions, and let go of the files. */
	close(): Promise<void>;
}

/** Mount the bundled plugins, each through the same `ctx.plugin` a user plugin would use. */
function mountBundled(
	ctx: Context,
	names: readonly BundledPluginName[],
	deps: {
		manager: SessionManager;
		providers: ProviderConfigStore;
		settings: SettingsStore;
		home: string;
		fetch?: typeof fetch;
	},
): { mounted: MountedPlugin[]; fibers: { dispose(): Promise<void> }[] } {
	const mounted: MountedPlugin[] = [];
	const fibers: { dispose(): Promise<void> }[] = [];
	const record = (name: string, error?: string): void => {
		mounted.push({ name, source: "bundled", ...(error === undefined ? {} : { error }) });
	};
	const load = (name: BundledPluginName, plugin: unknown): void => {
		try {
			// The fiber is what a plugin *is* once loaded: disposing it runs every effect the plugin
			// registered, which is how "unmount" is the same operation as "unload".
			fibers.push(ctx.plugin(plugin as never, undefined as never) as unknown as { dispose(): Promise<void> });
			record(name);
		} catch (error) {
			// A bundled plugin that will not load is reported, not fatal: the rest of the floor
			// still serves, and `hello` says which plugin is missing and why.
			record(name, error instanceof Error ? error.message : String(error));
		}
	};
	if (names.includes("sessions")) load("sessions", sessionsPlugin({ manager: deps.manager }));
	if (names.includes("providers")) {
		load(
			"providers",
			providersPlugin({ store: deps.providers, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) }),
		);
	}
	if (names.includes("settings")) load("settings", settingsPlugin({ store: deps.settings }));
	if (names.includes("personas")) load("personas", personasPlugin({ manager: deps.manager, home: deps.home }));
	return { mounted, fibers };
}

export async function assembleServer(options: AssembleOptions): Promise<AssembledServer> {
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const configPath = options.configPath ?? defaultConfigPath(homedir());
	const ctx = new Context();
	const wire = new WireService(ctx, { warn });
	const providers = new ProviderConfigStore({
		path: configPath,
		warn,
		// The config file is shared with an editor, so the server watches it: a provider added by
		// hand takes effect on the next request without anything being restarted.
		watchIntervalMs: 2_000,
	});
	const settings = new SettingsStore({ path: settingsPath(options.dataDir), warn });

	// The model layer, from the config as it stands. Built once here and handed to every session:
	// which model a session uses is the session's own configuration, but *how* to reach a
	// provider is the server's.
	const readConfig = async (): Promise<EtaProviderConfig[]> => {
		try {
			const { config } = await providers.read();
			return config.providers ?? [];
		} catch (error) {
			warn(`[eta-server] ${String(error)}`);
			return [];
		}
	};
	let models: KernelModels | undefined = options.models;
	if (models === undefined) {
		try {
			const built = await buildModels(await readConfig(), { warn });
			models = built.models;
		} catch (error) {
			warn(`[eta-server] could not build the model layer: ${String(error)}`);
		}
	}
	const kernelModels: KernelModels = models ?? {
		// No providers configured: every model resolution fails, which is exactly what
		// `model_unavailable` means. A keyless fake here would make the failure look like a
		// provider problem much later, at request time.
		getModel: () => undefined,
		streamSimple: () => {
			throw new Error("model_unavailable: no providers are configured");
		},
		completeSimple: async () => {
			throw new Error("model_unavailable: no providers are configured");
		},
	};

	// The network settings in force, put into the environment *before* anything builds a client:
	// whatever the provider layer uses later picks them up the way any Node process would. The
	// status it returns is what a settings page shows, including the warning that a configured
	// proxy (a PAC file, a SOCKS-only system proxy) is not being used — the one thing a user cannot
	// find out any other way.
	if (options.network !== false) {
		try {
			const { config } = await providers.read();
			const status = await initializeNetwork(config.network ?? { mode: "system" });
			if (status.warning !== undefined) warn(`[eta-server] network: ${status.warning} (source: ${status.source})`);
		} catch (error) {
			warn(`[eta-server] could not apply network settings: ${String(error)}`);
		}
	}

	const store = new FileSessionStore({ root: join(options.dataDir, "sessions"), warn });
	const envFor = options.envFor;
	const sessions = new SessionManager({
		...(envFor === undefined ? {} : { envFor }),
		store,
		modelsFor: () => kernelModels,
		settings: () => settings.read(),
		// The cards that apply to a session's directory, read when it opens: a card written by hand
		// is picked up by the next session, and a card that is gone resolves to the fallback.
		personasFor: (meta) =>
			discoverPersonas({ cwd: meta.cwd, home: options.home ?? homedir(), warn }).then((cards) => [
				...cards.values(),
			]),
		// The skills that apply to a session's directory, rendered once at open. Discovery needs a
		// filesystem, and the session's own is the right one: a skill on the far side of an SSH
		// session is a skill that machine has.
		skillsFor: async (meta) => {
			const environment = envFor?.(meta);
			if (environment === undefined) return "";
			return await renderSkillsBlock({
				env: environment.env,
				cwd: meta.cwd,
				home: options.home ?? homedir(),
				warn,
			});
		},
		// The platform briefing: the words are the harness's, these are this app's paths. It is what
		// lets the agent change its own setup instead of asking a human where things go.
		platformFor: (meta) => {
			const home = options.home ?? homedir();
			return {
				cwd: meta.cwd,
				home,
				configPath,
				sessionDir: join(options.dataDir, "sessions", meta.id),
				memoryTarget: join(meta.cwd, ".eta", "MEMORY.md"),
				// A synchronous stat: the briefing is rendered per generation and a fact about
				// whether a file exists is cheap enough to read then.
				memoryExists: existsSync(join(meta.cwd, ".eta", "MEMORY.md")),
			};
		},
		// The project's memory, read and written through the session's own filesystem, and the
		// extraction call it makes at a run boundary. The call is the session's own model: notes
		// that cost tokens are notes the session pays for.
		memoryFor: (meta) => ({
			home: options.home ?? homedir(),
			call: async (systemPrompt, prompt) => {
				const identity = meta.model === undefined ? undefined : parseModelId(meta.model);
				const model =
					identity === undefined ? undefined : kernelModels.getModel(identity.provider, identity.modelId);
				if (model === undefined) {
					// No model to ask: a throw here is a declined extraction, which is the honest
					// outcome — inventing notes would be worse.
					throw new Error(`model_unavailable: ${meta.model ?? "unknown"}`);
				}
				const reply = await kernelModels.completeSimple(
					model,
					{
						systemPrompt,
						messages: [
							{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() } as never,
						],
					},
					{},
				);
				return messageText(reply);
			},
		}),
		...(options.compaction === undefined ? {} : { compaction: options.compaction }),
		warn,
	});

	const wanted = options.plugins ?? (["sessions", "providers", "settings", "personas"] as const);
	const bundled = mountBundled(ctx, wanted, {
		manager: sessions,
		providers,
		settings,
		home: options.home ?? homedir(),
	});

	// The scanned plugins: official ones from `modules/`, the user's from `plugins/`. Loaded
	// through the same `ctx.plugin` as the bundled ones — the only difference is who shipped
	// them, and whether they can be reloaded without a restart.
	const dirs = pluginDirs(options.dataDir);
	const manager = new PluginManager({ modulesDir: dirs.modules, pluginsDir: dirs.plugins, warn });
	const _scanned = await manager.loadAll(ctx);

	// `mounted` is read live: a plugin loaded later (or reloaded) shows up in the next `hello`.
	const listMounted = (): MountedPlugin[] => [...bundled.mounted, ...manager.mounted()];
	const server = serveWire({ wire, mounted: listMounted, warn }, { port: options.port ?? 0 });

	return {
		ctx,
		wire,
		sessions,
		server,
		manager,
		mounted: listMounted,
		async close() {
			server.stop();
			providers.stop();
			// The plugins first: their effects are what hold subscriptions and state targets, and
			// unloading them is what leaves the rest of the shutdown nothing to unwind.
			manager.stop();
			await manager.dispose();
			for (const fiber of bundled.fibers.splice(0)) await fiber.dispose();
			await sessions.closeAll();
			await store.close();
		},
	};
}
