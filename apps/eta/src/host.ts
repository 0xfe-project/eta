import type { KernelModels } from "@eta/core";
import type { MountedPlugin } from "@eta/server";
import type { HostStatus } from "./bundled/host";
import type { EtaConfig } from "./config";
import type { Migration } from "./db/migrations";
import type { ProviderBuildFailure } from "./providers/runtime";
/**
 * The host: read the config, open the database, build the cordis tree, mount the plugins,
 * listen — and be able to stop in the reverse order.
 *
 * One process, one cordis root. A session gets its own root when it is opened (REFACTOR.md §9,
 * P0.7), because cordis dispatches a tree's events tree-wide: two kernels under one root would
 * hear each other's events.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { createLocalEnvironment } from "@eta/execution-node";
import { FileSessionStore, PluginManager, SessionManager } from "@eta/server";
import { Context } from "cordis";
import { AgentStore } from "./agents/store";
import { adminPlugin } from "./bundled/admin";
import { agentsPlugin } from "./bundled/agents";
import { compatPlugin } from "./bundled/compat";
import { groupsPlugin } from "./bundled/groups";
import { hostPlugin } from "./bundled/host";
import { sessionsPlugin } from "./bundled/sessions";
import { tasksPlugin } from "./bundled/tasks";
import { usagePlugin } from "./bundled/usage";
import { codexAuthPath, CodexCredentialStore } from "./codex-auth";
import { approvalTools, configuredProviders, readConfig } from "./config";
import { databasePath, openDatabase } from "./db/database";
import {
  applyMigrations,
  loadMigrations,
  schemaVersion,
} from "./db/migrations";
import { DbService } from "./db/service";
import { TimelineProjector } from "./groups/projection";
import { WakeRunner } from "./groups/runner";
import { GroupStore } from "./groups/store";
import { EventHub } from "./http/events";
import { IdempotencyStore, withIdempotency } from "./http/idempotency";
import { approvalMiddleware } from "./interactions/approval";
import { AskBridge } from "./interactions/bridge";
import { InteractionStore } from "./interactions/store";
import { providerCatalog } from "./providers/catalog";
import { buildModels } from "./providers/runtime";
import { RouteRegistry, RouteService } from "./routes";
import { TaskCards } from "./tasks/cards";
import { TaskStore } from "./tasks/store";
import { taskTools } from "./tasks/tools";
import { recordingModels, subjectOf } from "./usage/recorder";
import { UsageStore } from "./usage/store";

export interface HostOptions {
  /** Where sessions, plugins and the database live: one directory. */
  dataDir: string;
  /** The providers config file. Defaults to `<dataDir>/config.json`. */
  configPath?: string;
  /** The port to listen on. Zero means "any free one". */
  port?: number;
  /** The interface to listen on. Defaults to loopback (REFACTOR.md §7.1). */
  hostname?: string;
  /** How often to look for edits in the user's plugin directory. Zero disables watching. */
  watchIntervalMs?: number;
  /** The migrations to apply. Defaults to the ones on disk. */
  migrations?: readonly Migration[];
  /**
   * The model layer, when the host has one of its own — a test with scripted answers. Omitted,
   * it is built from the config, which is what a normal start does.
   */
  models?: KernelModels | undefined;
  /** How many events stay replayable. Defaults to the hub's own (512); a test wants a small one. */
  hubCapacity?: number | undefined;
  warn?: (message: string) => void;
}

export interface Host {
  ctx: Context;
  routes: RouteService;
  db: DbService;
  /** Where modules publish what a client follows; `/events` is this hub's. */
  hub: EventHub;
  /** The configured providers as one model layer, or `undefined` when none are configured. */
  models: KernelModels | undefined;
  /** The sessions this process holds open, and the store they come from. */
  sessions: SessionManager;
  store: FileSessionStore;
  /** What a conversation belongs to. An agent is a configuration, not a conversation. */
  agents: AgentStore;
  /** Who spent what: every generation is counted as it happens. */
  usage: UsageStore;
  /** Groups: who is in them, what was said, and what woke whom. */
  groups: GroupStore;
  /** Providers that could not be built, with the reason. The rest are in `models`. */
  providerFailures: readonly ProviderBuildFailure[];
  port: number;
  config: EtaConfig;
  mounted: () => MountedPlugin[];
  close: () => Promise<void>;
}

export async function assembleHost(options: HostOptions): Promise<Host> {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const configPath = options.configPath ?? join(options.dataDir, "config.json");
  const config = await readConfig(configPath, warn);

  const ctx = new Context();

  // The database first: a module that injects `db` must find a migrated schema, not a promise.
  const dbPath = databasePath(options.dataDir);
  const handle = await openDatabase(dbPath);
  const migrations = options.migrations ?? (await loadMigrations());
  const applied = applyMigrations(handle, migrations);
  if (applied.length > 0) {
    warn(
      `[eta] applied ${applied.length} migration(s) to ${dbPath}: ${applied.join(", ")}`,
    );
  }
  const db = new DbService(ctx, { path: dbPath, handle, applied });

  // The model layer, built from the config: this is what a session asks for a model by name
  // (P0.6). A provider that cannot be built is a warning and a line in /host, not a dead host —
  // the ones that work still work.
  const providers = configuredProviders(config);
  const approvals = approvalTools(config);
  // When these connections were last changed: the config file is where they live, so its mtime is
  // the closest thing to "added at" that exists — and it is a fact, not a guess.
  const configWrittenAt = await stat(configPath)
    .then((info) => info.mtime.toISOString())
    .catch(() => new Date().toISOString());
  const credentials = new CodexCredentialStore(codexAuthPath(configPath));
  const { models: built, failed } = await buildModels(providers, {
    credentials,
    warn,
  });
  // A host may bring its own model layer (a test with scripted answers); otherwise it is the
  // one the config named.
  const models = options.models ?? built;

  // Idempotency sits in front of every POST that carries a key: a retry gets the first answer
  // instead of a second effect (P0.5).
  const idempotency = new IdempotencyStore(handle);
  // Usage, counted as it happens (P1.3). The table is kept for 30 days; pruning on the way up
  // keeps it from growing forever without a scheduler of its own.
  const usage = new UsageStore(handle);
  const pruned = usage.prune();
  if (pruned > 0)
    warn(`[eta] dropped ${pruned} usage row(s) older than the retention`);

  // The stores and the event hub first: the session manager down the page needs to be told where
  // a session's questions go, and its observer needs them (P2.6). Only the manager itself is
  // circular — a session's observer is only ever called once a session exists, which is after
  // this file has finished assembling — so the bridge is the one piece that is late.
  const hub = new EventHub(
    options.hubCapacity === undefined ? {} : { capacity: options.hubCapacity },
  );
  const agents = new AgentStore(handle);
  const groups = new GroupStore(handle);
  const interactions = new InteractionStore(handle);
  const tasks = new TaskStore(handle);
  // Wakes become runs here (P2.2): one session per (agent × group), found by the participant row
  // and remembered in the session's own meta. The projector also closes a reply's questions when it
  // ends, so a card never outlives the run that asked it.
  const projector = new TimelineProjector({ groups, hub, interactions });
  // The task board's cards (P3.1): a draft in a group becomes one, and it follows the task after.
  const cards = new TaskCards({ groups, tasks, projector });
  // The bridge needs the manager and the manager needs the bridge's observer (a session's questions
  // are surfaced through it). One of the two has to be late, and it is the observer: it is only
  // called once a session exists, which is after this file has finished assembling.
  const bridgeRef: { current?: AskBridge } = {};

  // Sessions: jsonl journals and a meta file each, under the data directory (P0.7). The
  // manager decides nothing about models — it asks, per session — so which provider a session
  // uses stays the application's decision.
  const store = new FileSessionStore({
    root: join(options.dataDir, "sessions"),
    warn,
  });
  const sessions = new SessionManager({
    store,
    modelsFor: (meta) => {
      if (models === undefined)
        throw new Error("no model providers are configured");
      // One wrapper per session, so the row knows which subject asked (P1.3).
      return recordingModels(models, {
        store: usage,
        subject: subjectOf(meta),
      });
    },
    // A new session starts on the config's default model. Read once at startup, so changing the
    // file needs a restart — settings, and the per-session choice, are P1's and P2's business.
    defaults:
      config.defaultModel === undefined ? {} : { model: config.defaultModel },
    envFor: (meta) => {
      const env = createLocalEnvironment(meta.cwd);
      return env === undefined ? undefined : { env };
    },
    // A session's questions become interaction rows (P2.6), which is what the product's
    // confirmation cards are.
    askObserve: (meta) => (action, payload) =>
      bridgeRef.current?.observe(meta, action, payload),
    // The task board's tools (P3.1): what an agent in a group can do with the board. Read per
    // session, because a draft belongs to the group that session is in.
    sessionTools: ({ meta }) =>
      taskTools({
        tasks,
        cards,
        meta,
        agentName: (agentId) => agents.get(agentId)?.name,
      }),
    // Tools the config lists ask before they run: the same card, raised by a rule rather than by
    // the model. Read per session, so a policy change reaches the next session.
    toolMiddleware: ({ meta, session }) => {
      const middleware = approvalMiddleware({
        tools: approvals,
        ask: session.ask,
        meta,
      });
      return middleware === undefined ? [] : [middleware];
    },
    warn,
  });

  const routes = new RouteService(
    ctx,
    new RouteRegistry((request, run) =>
      withIdempotency(idempotency, request, run),
    ),
  );
  // Wakes become runs here (P2.2): one session per (agent × group), found by the participant
  // row and remembered in the session's own meta. The projector also closes a reply's questions
  // when it ends, so a card never outlives the run that asked it.
  const runner = new WakeRunner({
    groups,
    sessions,
    agents,
    projector,
    hub,
    warn,
  });
  const bridge = new AskBridge({
    interactions,
    groups,
    sessions,
    projector,
    hub,
  });
  // The manager was handed a closure that reads this; by the time a session opens, it is set.
  bridgeRef.current = bridge;

  const status: HostStatus = {
    pid: process.pid,
    dataDir: options.dataDir,
    dbPath,
    schema: schemaVersion(handle),
    startedAt: Date.now(),
    providers: providers.map(
      (provider) =>
        `${provider.id}${provider.name === undefined ? "" : ` (${provider.name})`}` +
        `${failed.some((failure) => failure.id === provider.id) ? " — unusable" : ""}`,
    ),
    mounted: [],
  };

  // The floor's own routes: with no plugins mounted at all, the host still answers, and there is
  // still somewhere for a client to listen.
  routes.register("GET", "/health", () => Response.json({ ok: true }));
  routes.register("GET", "/events", (request) => hub.handle(request));

  // The bundled plugins. Everything else that answers a request is one of these or a user
  // plugin; the floor knows no feature name of its own.
  const fibers = [
    ctx.plugin(hostPlugin, { status }),
    ctx.plugin(sessionsPlugin, { sessions, hub }),
    ctx.plugin(agentsPlugin, { agents, groups, hub, models }),
    ctx.plugin(usagePlugin, { usage }),
    // The management surface a settings page reads (P1.4): derived, never stored.
    ctx.plugin(adminPlugin, {
      providers,
      catalog: providerCatalog(),
      failures: failed,
      signedIn: async () =>
        (await credentials.list()).map((entry) => entry.providerId),
      usage,
      createdAt: configWrittenAt,
    }),
    ctx.plugin(groupsPlugin, { groups, runner, projector }),
    // The task board (P3.1): the local half — the board, its timeline, and the cards a group's
    // draft becomes.
    ctx.plugin(tasksPlugin, { tasks, cards, groups, agents }),
    // The product API the existing web speaks (P2.4): AXP's shapes over our rows.
    ctx.plugin(compatPlugin, {
      agents,
      ask: bridge,
      groups,
      hub,
      interactions,
      models,
      runner,
    }),
  ];

  const manager = new PluginManager({
    modulesDir: join(options.dataDir, "modules"),
    pluginsDir: join(options.dataDir, "plugins"),
    warn,
    ...(options.watchIntervalMs === undefined
      ? {}
      : { watchIntervalMs: options.watchIntervalMs }),
  });
  status.mounted = (await manager.loadAll(ctx)).map((plugin) =>
    plugin.error === undefined
      ? plugin.name
      : `${plugin.name} (${plugin.error})`,
  );
  if (options.watchIntervalMs !== undefined && options.watchIntervalMs > 0)
    manager.watch(ctx);

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
    fetch: (request) => routes.dispatch(request),
  });

  return {
    ctx,
    routes,
    db,
    hub,
    models,
    providerFailures: failed,
    sessions,
    store,
    agents,
    groups,
    usage,
    port: server.port ?? 0,
    config,
    mounted: () => manager.mounted(),
    async close() {
      // Reverse order: stop taking requests, take the plugins out (the user's first, then
      // ours — their effects unregister what they registered), take back whatever routes are
      // left, and only then close the file. A route a plugin forgot to clean up goes with
      // the rest, so stopping is a shutdown rather than a leak.
      server.stop();
      manager.stop();
      await manager.dispose();
      for (const fiber of fibers.splice(0)) await fiber.dispose();
      routes.registry.clear();
      // Sessions write their journals here, so they go before the store and the file.
      await sessions.closeAll();
      await store.close();
      handle.close();
    },
  };
}
