import type { AssistantMessage } from "@earendil-works/pi-ai";
/**
 * The product: the stores, the engine, and the plugins that put them on the wire.
 *
 * It is made before the server (the engine's hooks are options of `assembleServer`) and mounted
 * on it afterwards: the plugins need the server's wire and its session host, which only exist
 * then. Between the two, the replies a dead process left in flight are failed, so nothing a client
 * is ever shown says `working` without something working.
 */
import type { ConfigInput } from "@eta/plugin-akhook";
import type {
  AssembledServer,
  RemoteSessions,
  SessionMeta,
  WebSocketEndpoint,
  WireService,
} from "@eta/server";
import type { Database } from "bun:sqlite";
import type { SiteLimits } from "./artifacts/site";
import type { SessionHooks } from "./session-hooks";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { agentsPlugin } from "./agents/plugin";
import { AgentStore } from "./agents/store";
import { AkhookHost } from "./akhook";
import { loadKey } from "./artifacts/capability";
import { artifactsPlugin } from "./artifacts/plugin";
import { createArtifactRoutes } from "./artifacts/routes";
import { ArtifactService } from "./artifacts/service";
import { DEFAULT_LIMITS } from "./artifacts/site";
import { ArtifactStore } from "./artifacts/store";
import { artifactSessionTools } from "./artifacts/tools";
import { combineRunHooks, Engine, RESTART_TEXT } from "./conversations/engine";
import { conversationsPlugin } from "./conversations/plugin";
import { ConversationStore } from "./conversations/store";
import { ConversationTargets } from "./conversations/targets";
import { Timeline } from "./conversations/timeline";
import { Inbox } from "./inbox/inbox";
import { inboxPlugin } from "./inbox/plugin";
import { SettingStore } from "./inbox/setting";
import { InteractionStore } from "./inbox/store";
import { MachineHub } from "./machines/hub";
import { SessionMirrors } from "./machines/mirror";
import { machinesPlugin } from "./machines/plugin";
import { RemotePlace } from "./machines/remote-place";
import { RemoteSessionsRouter } from "./machines/remote-sessions";
import { serveLink } from "./machines/service";
import { MachineStore } from "./machines/store";
import { MemoryClient } from "./memory/client";
import { memoryRunHooks, memoryTools } from "./memory/hooks";
import { memoryPlugin } from "./memory/plugin";
import { projectsPlugin } from "./projects/plugin";
import { ProjectStore } from "./projects/store";
import { routinesPlugin } from "./routines/plugin";
import { INTERRUPTED, RoutineRunner } from "./routines/runner";
import { Scheduler } from "./routines/scheduler";
import { RoutineStore } from "./routines/store";
import { combineSessionHooks } from "./session-hooks";
import { TaskBoard } from "./tasks/board";
import { TaskCards } from "./tasks/cards";
import { tasksPlugin } from "./tasks/plugin";
import { TaskStore } from "./tasks/store";
import { taskSessionTools } from "./tasks/tools";
import { usagePlugin } from "./usage/plugin";
import { entryOf } from "./usage/recorder";
import { UsageStore } from "./usage/store";

export interface AkhookOptions {
  /** The user-level configuration file; defaults to akhook's own path. */
  userConfigPath?: string | undefined;
  /** Host layers that neither the user's nor a project's file can disable or replace. */
  additional?: readonly ConfigInput[] | undefined;
}

/** What a test sets to move time by hand; a real host leaves all of it alone. */
export interface RoutinesOptions {
  /** The clock, in epoch milliseconds. Everything the routines record or compute reads it. */
  now?: () => number;
  /** How long a run may take. */
  timeoutMs?: number;
  /** How long a revision of a brief from feedback may take. */
  reviseTimeoutMs?: number;
  /** False leaves the timer off, and the scheduler looks at the clock only when told to. */
  timer?: boolean;
}

export interface Product {
  readonly engine: Engine;
  /** The links to other machines. */
  readonly hub: MachineHub;
  /** The routines' clock; `tick()` makes it look. */
  readonly scheduler: Scheduler;
  /** Every feature's per-session hooks, combined into the one set the session manager takes. */
  readonly sessionHooks: Required<SessionHooks>;
  /** Count a model request that ended; the server tells it for every session it holds. */
  readonly generated: (meta: SessionMeta, message: AssistantMessage) => void;
  /** Mount the plugins on an assembled server; resolves when every one of them is in place. */
  mount: (server: AssembledServer) => Promise<void>;
  /** The product's own HTTP routes (artifact pages, enrolling a machine); nothing for any other path. */
  fetch: (request: Request) => Promise<Response | undefined>;
  /** Where `sessions.*` actions for sessions on other machines go. */
  readonly remote: RemoteSessions;
  /** The product's own WebSocket routes: the link daemons dial. */
  readonly endpoints: readonly WebSocketEndpoint[];
  /** Cut the links to other machines (the host is stopping). */
  close: () => void;
}

/** The plugins are applied a moment after they are mounted; this is how long to wait for that. */
const MOUNT_TIMEOUT_MS = 10_000;

export function createProduct(options: {
  db: Database;
  dataDir: string;
  /** The memory sidecar's address. Without one there is no memory: no plugin, no tools, no calls. */
  memoryUrl?: string | undefined;
  /** akhook: the user-level file, and host layers beyond the environment's and the data directory's. */
  akhook?: AkhookOptions | undefined;
  warn: (message: string) => void;
  /** The interface the host listens on, for the address a new machine is told to dial. */
  hostname?: string | undefined;
  /** The agent's home, where the user's own persona cards are. Defaults to the real one. */
  home?: string | undefined;
  routines?: RoutinesOptions;
  /** Overrides of what a published site may hold. */
  artifactLimits?: Partial<SiteLimits> | undefined;
}): Product {
  const { db, dataDir, warn } = options;
  const memory =
    options.memoryUrl === undefined || options.memoryUrl === ""
      ? undefined
      : new MemoryClient(options.memoryUrl);
  const agents = new AgentStore(db);
  const machines = new MachineStore(db);
  const projects = new ProjectStore(db);
  const conversations = new ConversationStore(db);
  const timeline = new Timeline(db);
  let wire: WireService | undefined;

  // This computer is a machine like any other, and the first thing a project can name.
  machines.ensurePrimary({ name: hostname(), home: homedir(), os: platform() });
  // Nothing is connected yet: a daemon that was online when the last process stopped is not.
  machines.markDaemonsOffline();
  // Nothing is running yet, so whatever the last process left in flight cannot be, and no
  // question it asked can still be answered.
  timeline.failInterrupted(RESTART_TEXT);
  const interactions = new InteractionStore(db);
  interactions.expirePending();
  // Settled questions are kept for 30 days, like usage; the ones just expired above are new.
  interactions.prune();
  // Usage is kept for 30 days; what is older goes now, and again once a day while the host runs.
  const usage = new UsageStore(db);
  usage.prune();

  /** Say that product state moved, to whoever is looking at it. */
  const changed = (touched?: readonly string[] | "all"): void => {
    if (wire === undefined) return;
    for (const target of ["agents", "machines", "projects", "conversations"])
      wire.pushNow(target);
    const ids =
      touched === "all"
        ? conversations.list().map((c) => c.id)
        : (touched ?? []);
    for (const id of ids) wire.pushNow(`conversations.${id}`);
  };

  // The routines: their rows, the runs that carry them out and the clock that starts the runs.
  const now = options.routines?.now ?? Date.now;
  const routines = new RoutineStore(db, now);
  // A run the last process left going is not going now.
  routines.recover(INTERRUPTED);
  const routinesChanged = (routineId: string): void => {
    wire?.pushNow("routines");
    wire?.pushNow(`routines.${routineId}`);
  };
  const runner = new RoutineRunner({
    store: routines,
    timeline,
    dataDir,
    now,
    timeoutMs: options.routines?.timeoutMs,
    reviseTimeoutMs: options.routines?.reviseTimeoutMs,
    changed: routinesChanged,
    posted: (conversationId) => changed([conversationId]),
    warn,
  });
  // A model request ended, for a session of this host or of a daemon: count it.
  const generated = (meta: SessionMeta, message: AssistantMessage): void => {
    try {
      usage.record(entryOf(meta, message, runner.routineOf(meta) ?? null));
      // Run traffic, not a click: the paced push, so a busy agent costs a bounded number of frames.
      wire?.push("usage");
    } catch (error) {
      warn(`[eta] could not record a generation: ${String(error)}`);
    }
  };
  const scheduler = new Scheduler({
    store: routines,
    fire: (routineId) => runner.start(routineId, "schedule") !== undefined,
    now,
    timer: options.routines?.timer ?? true,
    warn,
  });

  // Other machines. What the primary does for them needs the server (its models) and the
  // product's own hooks and tables, none of which exist yet, so it reads them when asked.
  let running: AssembledServer | undefined;
  const later: {
    hooks?: Required<SessionHooks>;
    inbox?: Inbox;
    akhook?: AkhookHost;
  } = {};
  const hub = new MachineHub({
    machines,
    changed: () => wire?.pushNow("machines"),
    warn,
    serve: (link) =>
      serveLink(link, {
        conversations,
        projects,
        machines,
        models: () => running?.models,
        hooks: () => later.hooks,
        approvals: () => later.inbox?.approvals() ?? [],
        generated,
        warn,
      }),
  });
  const mirrors = new SessionMirrors(hub, (id) => machines.get(id)?.name);
  const router = new RemoteSessionsRouter({
    conversations,
    machines,
    hub,
    models: () => running?.models,
    rows: () => mirrors.rows(),
  });
  const remotePlace = new RemotePlace({
    hub,
    mirrors,
    models: () => running?.models,
    defaults: async () => (await running?.defaults()) ?? {},
    hooks: () => later.hooks,
    akhook: () => later.akhook?.layerTexts() ?? [],
    home: options.home ?? homedir(),
    forward: (action, args) => router.forward(action, args),
    warn,
  });

  const targets = new ConversationTargets({
    conversations,
    projects,
    timeline,
  });
  const created = (id: string): void => targets.add(id);

  // The task board, and the artifacts its cards list.
  const taskRows = new TaskStore(db);
  const artifactRows = new ArtifactStore(db);
  const artifactsOf = (taskId: string) => artifactRows.latestOfTask(taskId);
  const board = new TaskBoard({
    db,
    tasks: taskRows,
    cards: new TaskCards({
      db,
      tasks: taskRows,
      timeline,
      conversations,
      artifactsOf,
    }),
    conversations,
    artifactsOf,
    changed,
  });
  const inbox = new Inbox({
    interactions,
    settings: new SettingStore(db),
    timeline,
    changed: () => wire?.pushNow("inbox"),
    warn,
  });
  // The rules of the user's akhook files and the host's own, and the approval list: one set of
  // tool-call checks per session, one question when several of them want to ask.
  const akhook = new AkhookHost({
    dataDir,
    userConfigPath: options.akhook?.userConfigPath,
    additional: options.akhook?.additional,
    approvals: () => inbox.approvals(),
    warn,
  });
  const engine = new Engine({
    db,
    agents,
    machines,
    projects,
    conversations,
    timeline,
    changed,
    warn,
    remote: remotePlace,
    runHooks: combineRunHooks([
      akhook.runHooks,
      ...(memory === undefined ? [] : [memoryRunHooks(memory)]),
    ]),
  });

  const limits = { ...DEFAULT_LIMITS, ...options.artifactLimits };
  const artifactsRoot = join(dataDir, "artifacts");
  const artifacts = new ArtifactService({
    store: artifactRows,
    root: artifactsRoot,
    limits,
    key: loadKey(join(artifactsRoot, ".preview-key")),
    changed: () => wire?.pushNow("artifacts"),
  });
  const artifactRoutes = createArtifactRoutes(artifacts);

  // Each feature that adds tools, tool middleware or a question observer to sessions is one entry
  // here; the order is the order its tools and middleware are installed in.
  const sessionHooks = combineSessionHooks([
    {
      sessionTools: engine.sessionTools,
      askObserve: engine.askObserve,
    },
    { sessionTools: runner.sessionTools },
    { sessionTools: taskSessionTools({ board, agents }) },
    { sessionTools: artifactSessionTools({ artifacts, board, limits }) },
    {
      toolMiddleware: akhook.toolMiddleware,
      sessionAttach: akhook.sessionAttach,
      askObserve: inbox.askObserve,
    },
    ...(memory === undefined
      ? []
      : [{ sessionTools: memoryTools.bind(undefined, memory) }]),
  ]);

  later.hooks = sessionHooks;
  later.inbox = inbox;
  later.akhook = akhook;

  return {
    engine,
    hub,
    scheduler,
    sessionHooks,
    generated,
    fetch: async (request) =>
      (await hub.enroll(request)) ?? (await artifactRoutes(request)),
    remote: router,
    endpoints: [hub.endpoint],
    close: () => {
      hub.close();
      mirrors.detach();
    },
    async mount(server) {
      running = server;
      wire = server.wire;
      // Sessions on other machines show on this wire like any other; the ones that already
      // exist are known from the participants that hold them.
      mirrors.attach(server.wire, () =>
        machines
          .list()
          .filter((machine) => machine.kind === "daemon")
          .flatMap((machine) =>
            conversations
              .sessionsOn(machine.id)
              .map((session) => ({ session, machineId: machine.id })),
          ),
      );
      const pending = new Set([
        "agents",
        "machines",
        "projects",
        "conversations",
        "routines",
        "tasks",
        "artifacts",
        "inbox",
        "usage",
        ...(memory === undefined ? [] : ["memory"]),
      ]);
      let ready!: () => void;
      const everyone = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const applied = (name: string) => () => {
        pending.delete(name);
        if (pending.size === 0) ready();
      };
      const shared = { agents, machines, projects, conversations, timeline };
      server.mount(
        "agents",
        agentsPlugin(
          { ...shared, dataDir, db, engine, changed, created },
          applied("agents"),
        ),
      );
      server.mount(
        "machines",
        machinesPlugin(
          {
            machines,
            hub,
            changed,
            defaultUrl: () =>
              `http://${options.hostname ?? "127.0.0.1"}:${server.server.port}`,
          },
          applied("machines"),
        ),
      );
      server.mount(
        "projects",
        projectsPlugin({ ...shared, hub, changed }, applied("projects")),
      );
      server.mount(
        "conversations",
        conversationsPlugin(
          { ...shared, engine, targets, changed, created },
          applied("conversations"),
        ),
      );
      server.mount(
        "routines",
        routinesPlugin(
          {
            store: routines,
            runner,
            scheduler,
            conversations,
            now,
            changed: routinesChanged,
          },
          applied("routines"),
        ),
      );
      server.mount("tasks", tasksPlugin({ board }, applied("tasks")));
      server.mount(
        "artifacts",
        artifactsPlugin({ artifacts, board }, applied("artifacts")),
      );
      server.mount("inbox", inboxPlugin({ inbox }, applied("inbox")));
      server.mount("usage", usagePlugin(usage, applied("usage")));
      if (memory !== undefined)
        server.mount(
          "memory",
          memoryPlugin({ client: memory }, applied("memory")),
        );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `the product plugins did not start: ${[...pending].join(", ")}`,
              ),
            ),
          MOUNT_TIMEOUT_MS,
        );
      });
      try {
        await Promise.race([everyone, late]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
