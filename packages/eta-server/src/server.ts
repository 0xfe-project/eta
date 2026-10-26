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

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { MountedPlugin } from "@eta/client-contracts";
import type { CompactionSummarizer, KernelModels } from "@eta/core";
import type { RemoteSessions } from "./bundled/sessions";
import type { SessionManagerOptions } from "./manager";
import type { EtaConfig } from "./providers/config-types";
import type { Settings } from "./settings";
import type { SessionMeta } from "./store";
import type { WireServer, WireServerOptions } from "./transport";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Context } from "cordis";
import { personasPlugin } from "./bundled/personas";
import { providersPlugin } from "./bundled/providers";
import { sessionsPlugin } from "./bundled/sessions";
import { settingsPlugin } from "./bundled/settings";
import { FileSessionStore } from "./file-store";
import { SessionManager } from "./manager";
import { formatModelId, parseModelId } from "./model-id";
import { initializeNetwork } from "./network";
import { observedModels } from "./observed-models";
import { discoverPersonas } from "./personas";
import { PluginManager } from "./plugins";
import { configDefaultModel } from "./providers/config-types";
import { buildModels } from "./providers/runtime";
import { defaultConfigPath, ProviderConfigStore } from "./providers/store";
import { messageText } from "./search";
import { settingsPath, SettingsStore } from "./settings";
import { renderSkillsBlock } from "./skills";
import { serveWire } from "./transport";
import { WireService } from "./wire-service";

export interface AssembleOptions {
  /** Where sessions live: one directory each. */
  dataDir: string;
  /** The providers config file. Defaults to `~/.eta/config.json`. */
  configPath?: string;
  /** The port to listen on. Zero means "any free one". */
  port?: number;
  /** The interface to listen on. Defaults to loopback (see `WireServerOptions.hostname`). */
  hostname?: string | undefined;
  /** Everything on the port that is not the socket (see `WireServerOptions.fetch`). */
  fetch?: WireServerOptions["fetch"];
  /** Asked before every request, the WebSocket upgrade included (see `WireServerOptions.authorize`). */
  authorize?: WireServerOptions["authorize"];
  /** More WebSocket routes than `/ws` (see `WireServerOptions.endpoints`). */
  endpoints?: WireServerOptions["endpoints"];
  /**
   * Where `sessions.*` actions for sessions that live on another machine go (see
   * `RemoteSessions`). Without one every session is local.
   */
  remoteSessions?: RemoteSessions | undefined;
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
  /**
   * Wraps the model layer once it is known, however it was made. A host that serves models of its
   * own beside the configured providers (the LLM gateway's) answers for those and hands the rest
   * to `base`.
   */
  overlayModels?: ((base: KernelModels) => KernelModels) | undefined;
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
  /**
   * The per-session hooks a host product wires into the manager (see `SessionManagerOptions`):
   * who the agent in a session is, what is added to its toolset, the policy on its tool calls, and who
   * hears about its questions. Passed straight through; the server never decides any of them.
   */
  agentPromptFor?: SessionManagerOptions["agentPromptFor"] | undefined;
  sessionTools?: SessionManagerOptions["sessionTools"] | undefined;
  /** Skill directories a session has beyond the ones found by walking its directory. */
  skillDirsFor?: ((meta: SessionMeta) => readonly string[]) | undefined;
  toolMiddleware?: SessionManagerOptions["toolMiddleware"] | undefined;
  askObserve?: SessionManagerOptions["askObserve"] | undefined;
  /**
   * Told how every model request a session makes ended: its turns, each retry of a turn, a
   * compaction's summary, a side question, a memory extraction and the turns of the subagents it
   * spawned. The session is named by its meta, so the host can say who it was made for.
   */
  generated?:
    | ((meta: SessionMeta, message: AssistantMessage) => void)
    | undefined;
  sessionAttach?: SessionManagerOptions["sessionAttach"] | undefined;
  warn?: ((message: string) => void) | undefined;
}

export type BundledPluginName =
  | "sessions"
  | "providers"
  | "settings"
  | "personas";

/** The plugin directories, as the layout in SERVER-REFACTOR.md §10 names them. */
export function pluginDirs(dataDir: string): {
  modules: string;
  plugins: string;
} {
  return {
    modules: join(dataDir, "modules"),
    plugins: join(dataDir, "plugins"),
  };
}

export interface AssembledServer {
  readonly ctx: Context;
  readonly wire: WireService;
  readonly sessions: SessionManager;
  readonly server: WireServer;
  /** The model layer sessions generate with: what a host proxies for a machine that has none. */
  readonly models: KernelModels;
  /** What a new session starts as: the user's settings, then the config's default model. */
  readonly defaults: () => Promise<Settings>;
  /** The scanned plugins: what is loaded, and what became of the ones that are not. */
  readonly manager: PluginManager;
  /**
   * Mount a plugin the host ships (a product's own), through the same `ctx.plugin` the bundled
   * ones use. It is listed in `mounted()` and unloaded by `close()` like they are; one that will
   * not load is reported there, not thrown.
   */
  mount: (name: string, plugin: unknown) => void;
  /** Every plugin mounted, and whatever stopped it. */
  mounted: () => MountedPlugin[];
  /** Stop listening, close the sessions, and let go of the files. */
  close: () => Promise<void>;
}

/** Mounts plugins on the context and remembers what became of each. */
function createMounter(ctx: Context): {
  mounted: MountedPlugin[];
  fibers: { dispose: () => Promise<void> }[];
  mount: (name: string, plugin: unknown) => void;
} {
  const mounted: MountedPlugin[] = [];
  const fibers: { dispose: () => Promise<void> }[] = [];
  const record = (name: string, error?: string): void => {
    mounted.push({
      name,
      source: "bundled",
      ...(error === undefined ? {} : { error }),
    });
  };
  const mount = (name: string, plugin: unknown): void => {
    try {
      // The fiber is what a plugin *is* once loaded: disposing it runs every effect the plugin
      // registered, which is how "unmount" is the same operation as "unload".
      fibers.push(
        ctx.plugin(plugin as never, undefined as never) as unknown as {
          dispose: () => Promise<void>;
        },
      );
      record(name);
    } catch (error) {
      // A bundled plugin that will not load is reported, not fatal: the rest of the floor
      // still serves, and `hello` says which plugin is missing and why.
      record(name, error instanceof Error ? error.message : String(error));
    }
  };
  return { mounted, fibers, mount };
}

/** Mount the bundled plugins, each through the same `ctx.plugin` a user plugin would use. */
function mountBundled(
  mount: (name: string, plugin: unknown) => void,
  names: readonly BundledPluginName[],
  deps: {
    manager: SessionManager;
    remote?: RemoteSessions | undefined;
    providers: ProviderConfigStore;
    settings: SettingsStore;
    home: string;
    fetch?: typeof fetch;
    /** Handed to the providers plugin: the config moved, so the model layer must follow. */
    onModelsChanged?: (() => void | Promise<void>) | undefined;
  },
): void {
  if (names.includes("sessions"))
    mount(
      "sessions",
      sessionsPlugin({
        manager: deps.manager,
        ...(deps.remote === undefined ? {} : { remote: deps.remote }),
      }),
    );
  if (names.includes("providers")) {
    mount(
      "providers",
      providersPlugin({
        store: deps.providers,
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        ...(deps.onModelsChanged === undefined
          ? {}
          : { onModelsChanged: deps.onModelsChanged }),
      }),
    );
  }
  if (names.includes("settings"))
    mount("settings", settingsPlugin({ store: deps.settings }));
  if (names.includes("personas"))
    mount(
      "personas",
      personasPlugin({ manager: deps.manager, home: deps.home }),
    );
}

export async function assembleServer(
  options: AssembleOptions,
): Promise<AssembledServer> {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const configPath = options.configPath ?? defaultConfigPath(homedir());
  const ctx = new Context();
  const wire = new WireService(ctx, { warn });
  const providers = new ProviderConfigStore({
    path: configPath,
    warn,
    // The config file is shared with an editor, so the server watches it. The tick is what makes
    // a provider added by hand real: the settings page sees it, and so does the model layer
    // (below, `reloadModels`), so no restart is involved on either side.
    watchIntervalMs: 2_000,
  });
  const settings = new SettingsStore({
    path: settingsPath(options.dataDir),
    warn,
  });

  // The config and the model layer built from it, both live. The file is shared with an editor
  // and with the settings page, and the store reports every change it sees. Which model a
  // session uses is the session's own configuration, but *how* to reach a provider is the
  // server's, and that has to follow the file: a provider added by hand is listed to the UI
  // within the watch tick, and must be generatable within it too, rather than after a restart.
  const readConfig = async (): Promise<EtaConfig | undefined> => {
    try {
      return (await providers.read()).config;
    } catch (error) {
      warn(`[eta-server] ${String(error)}`);
      return undefined;
    }
  };
  const noProviders: KernelModels = {
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
  /** The layer for one reading of the config. A failed build serves nothing, not something stale. */
  const buildLayer = async (source: EtaConfig): Promise<KernelModels> => {
    try {
      const built = await buildModels(source.providers ?? [], { warn });
      return built.models ?? noProviders;
    } catch (error) {
      warn(`[eta-server] could not build the model layer: ${String(error)}`);
      return noProviders;
    }
  };

  // A host that injects the layer (a test, or an embedding that builds providers differently)
  // owns it, and this server does not rebuild what it does not own.
  const injected = options.models;
  const ownsModelLayer = injected === undefined;
  /** The config as it now stands, and the layer built from it. Both move when the file does. */
  let live: EtaConfig = (await readConfig()) ?? {};
  let currentModels: KernelModels = injected ?? (await buildLayer(live));
  /**
   * The layer every session, the gateway overlay and the observing wrapper hold. It never
   * changes; what it delegates to does — so a rebuilt provider list reaches a session that has
   * been open since before the edit, on its very next turn. A layer the host injected is handed
   * over as it came (identity included): this server does not rebuild what it does not own, so
   * there is nothing for a delegate to do.
   */
  const configuredModels: KernelModels = injected ?? {
    getModel: (provider, id) => currentModels.getModel(provider, id),
    streamSimple: (model, context, callOptions) =>
      currentModels.streamSimple(model, context, callOptions),
    completeSimple: async (model, context, callOptions) =>
      await currentModels.completeSimple(model, context, callOptions),
  };
  /**
   * Re-read the config and rebuild the layer behind `configuredModels`. Serialised, so two saves
   * back to back cannot let the older layer land last.
   *
   * A config that no longer parses is reported and skipped: a typo made in an editor must not
   * take away the providers that were working a moment ago. An empty provider list, on the other
   * hand, is an answer and not a failure — it serves nothing, on purpose.
   */
  let reloadTail: Promise<unknown> = Promise.resolve();
  const reloadModels = (): Promise<void> => {
    if (!ownsModelLayer) return Promise.resolve();
    const run = reloadTail.then(async () => {
      const fresh = await readConfig();
      if (fresh === undefined) return;
      live = fresh;
      currentModels = await buildLayer(fresh);
    });
    reloadTail = run.catch(() => undefined);
    return run;
  };
  const kernelModels: KernelModels =
    options.overlayModels?.(configuredModels) ?? configuredModels;

  // The network settings in force, put into the environment *before* anything builds a client:
  // whatever the provider layer uses later picks them up the way any Node process would. The
  // status it returns is what a settings page shows, including the warning that a configured
  // proxy (a PAC file, a SOCKS-only system proxy) is not being used — the one thing a user cannot
  // find out any other way.
  if (options.network !== false) {
    try {
      const status = await initializeNetwork(
        live.network ?? { mode: "system" },
      );
      if (status.warning !== undefined)
        warn(
          `[eta-server] network: ${status.warning} (source: ${status.source})`,
        );
    } catch (error) {
      warn(`[eta-server] could not apply network settings: ${String(error)}`);
    }
  }

  // What a new session starts as: the user's settings, with the config's default model as the
  // last resort. The order matters — a model the user chose explicitly wins over the provider
  // file's default, which is a fallback and not an instruction. Without a provider to fall
  // back to, a session is left without a model and says so at its first run.
  const defaults = async (): Promise<Settings> => {
    const chosen = await settings.read();
    if (chosen.model !== undefined) return chosen;
    const fallback = configDefaultModel(live);
    return fallback === undefined
      ? chosen
      : { ...chosen, model: formatModelId(fallback) };
  };

  const store = new FileSessionStore({
    root: join(options.dataDir, "sessions"),
    warn,
  });
  const envFor = options.envFor;
  // The model layer one session talks to: the shared one, watched for the host when it asked to be.
  const modelsOf = (meta: SessionMeta): KernelModels => {
    const generated = options.generated;
    return generated === undefined
      ? kernelModels
      : observedModels(kernelModels, (message) => generated(meta, message));
  };
  const sessions = new SessionManager({
    ...(envFor === undefined ? {} : { envFor }),
    store,
    modelsFor: modelsOf,
    settings: defaults,
    // The cards that apply to a session's directory, read when it opens: a card written by hand
    // is picked up by the next session, and a card that is gone resolves to the fallback.
    personasFor: (meta) =>
      discoverPersonas({
        cwd: meta.cwd,
        home: options.home ?? homedir(),
        warn,
      }).then((cards) => [...cards.values()]),
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
        ...(options.skillDirsFor === undefined
          ? {}
          : { extraDirs: options.skillDirsFor(meta) }),
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
        const identity =
          meta.model === undefined ? undefined : parseModelId(meta.model);
        const models = modelsOf(meta);
        const model =
          identity === undefined
            ? undefined
            : models.getModel(identity.provider, identity.modelId);
        if (model === undefined) {
          // No model to ask: a throw here is a declined extraction, which is the honest
          // outcome — inventing notes would be worse.
          throw new Error(`model_unavailable: ${meta.model ?? "unknown"}`);
        }
        const reply = await models.completeSimple(
          model,
          {
            systemPrompt,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: prompt }],
                timestamp: Date.now(),
              } as never,
            ],
          },
          {},
        );
        return messageText(reply);
      },
    }),
    ...(options.compaction === undefined
      ? {}
      : { compaction: options.compaction }),
    ...(options.agentPromptFor === undefined
      ? {}
      : { agentPromptFor: options.agentPromptFor }),
    ...(options.sessionTools === undefined
      ? {}
      : { sessionTools: options.sessionTools }),
    ...(options.toolMiddleware === undefined
      ? {}
      : { toolMiddleware: options.toolMiddleware }),
    ...(options.askObserve === undefined
      ? {}
      : { askObserve: options.askObserve }),
    ...(options.sessionAttach === undefined
      ? {}
      : { sessionAttach: options.sessionAttach }),
    warn,
  });

  const wanted =
    options.plugins ??
    (["sessions", "providers", "settings", "personas"] as const);
  const mounter = createMounter(ctx);
  mountBundled(mounter.mount, wanted, {
    manager: sessions,
    remote: options.remoteSessions,
    providers,
    settings,
    home: options.home ?? homedir(),
    onModelsChanged: reloadModels,
  });

  // The scanned plugins: official ones from `modules/`, the user's from `plugins/`. Loaded
  // through the same `ctx.plugin` as the bundled ones — the only difference is who shipped
  // them, and whether they can be reloaded without a restart.
  const dirs = pluginDirs(options.dataDir);
  const manager = new PluginManager({
    modulesDir: dirs.modules,
    pluginsDir: dirs.plugins,
    warn,
  });
  const _scanned = await manager.loadAll(ctx);

  // `mounted` is read live: a plugin loaded later (or reloaded) shows up in the next `hello`.
  const listMounted = (): MountedPlugin[] => [
    ...mounter.mounted,
    ...manager.mounted(),
  ];
  const server = serveWire(
    { wire, mounted: listMounted, warn },
    {
      port: options.port ?? 0,
      ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
      fetch: options.fetch,
      authorize: options.authorize,
      endpoints: options.endpoints,
    },
  );

  return {
    ctx,
    wire,
    sessions,
    server,
    models: kernelModels,
    defaults,
    manager,
    mount: mounter.mount,
    mounted: listMounted,
    async close() {
      server.stop();
      providers.stop();
      // The plugins first: their effects are what hold subscriptions and state targets, and
      // unloading them is what leaves the rest of the shutdown nothing to unwind. Last mounted,
      // first unloaded: a host's plugin depends on the bundled ones, not the other way round.
      manager.stop();
      await manager.dispose();
      for (const fiber of mounter.fibers.splice(0).reverse())
        await fiber.dispose();
      await sessions.closeAll();
      await store.close();
    },
  };
}
