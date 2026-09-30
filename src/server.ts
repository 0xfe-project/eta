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
import { homedir } from "node:os";
import { join } from "node:path";
import type { MountedPlugin } from "@eta/client-wire-proto";
import type { CompactionSummarizer, KernelModels } from "@eta/core";
import { Context } from "cordis";
import { providersPlugin } from "./bundled/providers";
import { sessionsPlugin } from "./bundled/sessions";
import { settingsPlugin } from "./bundled/settings";
import { FileSessionStore } from "./file-store";
import { SessionManager } from "./manager";
import { PluginManager } from "./plugins";
import type { EtaProviderConfig } from "./providers/config-types";
import { buildModels } from "./providers/runtime";
import { defaultConfigPath, ProviderConfigStore } from "./providers/store";
import { SettingsStore, settingsPath } from "./settings";
import { serveWire, type WireServer } from "./transport";
import { WireService } from "./wire-service";

export interface AssembleOptions {
	/** Where sessions live: one directory each. */
	dataDir: string;
	/** The providers config file. Defaults to `~/.eta/config.json`. */
	configPath?: string;
	/** The port to listen on. Zero means "any free one". */
	port?: number;
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
	warn?: ((message: string) => void) | undefined;
}

export type BundledPluginName = "sessions" | "providers" | "settings";

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
	deps: { manager: SessionManager; providers: ProviderConfigStore; settings: SettingsStore; fetch?: typeof fetch },
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

	const store = new FileSessionStore({ root: join(options.dataDir, "sessions"), warn });
	const sessions = new SessionManager({
		store,
		modelsFor: () => kernelModels,
		settings: () => settings.read(),
		...(options.compaction === undefined ? {} : { compaction: options.compaction }),
		warn,
	});

	const wanted = options.plugins ?? (["sessions", "providers", "settings"] as const);
	const bundled = mountBundled(ctx, wanted, { manager: sessions, providers, settings });

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
