import type { AssistantMessage } from "@earendil-works/pi-ai";
/**
 * The product: the stores, the engine, and the plugins that put them on the wire.
 *
 * It is made before the server (the engine's hooks are options of `assembleServer`) and mounted
 * on it afterwards: the plugins need the server's wire and its session host, which only exist
 * then. Between the two, the replies a dead process left in flight are failed, so nothing a client
 * is ever shown says `working` without something working.
 */
import type { GitHubCredentials } from "@eta/client-contracts";
import type {
  AssembledServer,
  RemoteSessions,
  SessionMeta,
  WebSocketEndpoint,
  WireService,
} from "@eta/server";
import type { Database } from "bun:sqlite";
import type { SiteLimits } from "./artifacts/site";
import type { GatewayKeys } from "./bundles/bundles";
import type { GithubTuning } from "./github/service";
import type { MachineRecord } from "./machines/store";
import type { SessionHooks } from "./session-hooks";
import type { WebOptions } from "./web/service";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { GitHubKeeper } from "@eta/daemon";
import { agentsPlugin } from "./agents/plugin";
import { AgentStore } from "./agents/store";
import { loadKey } from "./artifacts/capability";
import { artifactsPlugin } from "./artifacts/plugin";
import { createArtifactRoutes } from "./artifacts/routes";
import { ArtifactService } from "./artifacts/service";
import { DEFAULT_LIMITS } from "./artifacts/site";
import { ArtifactStore } from "./artifacts/store";
import { artifactSessionTools } from "./artifacts/tools";
import { Bundles } from "./bundles/bundles";
import { bundlesPlugin } from "./bundles/plugin";
import { AttachmentStore } from "./conversations/attachments";
import { combineRunHooks, Engine, RESTART_TEXT } from "./conversations/engine";
import { conversationsPlugin } from "./conversations/plugin";
import { ConversationStore } from "./conversations/store";
import { ConversationTargets } from "./conversations/targets";
import { Timeline } from "./conversations/timeline";
import { EmailCredentials } from "./email/credentials";
import { emailPlugin } from "./email/plugin";
import { EmailService } from "./email/service";
import { EmailStore } from "./email/store";
import { emailSessionTools } from "./email/tools";
import { GithubError } from "./github/error";
import { githubPlugin } from "./github/plugin";
import { githubRoutes } from "./github/routes";
import { Github } from "./github/service";
import { githubSessionTools } from "./github/tools";
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
import { transportOn } from "./machines/shell";
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
import { loadSecretKey } from "./secret";
import { combineSessionHooks } from "./session-hooks";
import { TaskBoard } from "./tasks/board";
import { TaskCards } from "./tasks/cards";
import { tasksPlugin } from "./tasks/plugin";
import { TaskRunner } from "./tasks/runner";
import { TaskRunStore } from "./tasks/runs";
import { sessionKeyOf, taskOfKey } from "./tasks/session-key";
import { TaskStore } from "./tasks/store";
import { taskSessionTools } from "./tasks/tools";
import { workspaceChooser } from "./tasks/workspace";
import { usagePlugin } from "./usage/plugin";
import { entryOf } from "./usage/recorder";
import { UsageStore } from "./usage/store";
import { Web } from "./web/service";
import { webSessionTools } from "./web/tools";

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

/** What a test sets to keep tasks from running; a real host leaves all of it alone. */
export interface TasksOptions {
  /** False keeps the runner from taking runs: a task is made and confirmed, and nothing starts. */
  runs?: boolean;
}

export interface Product {
  readonly engine: Engine;
  /** The task board: what a test makes tasks with, since only agents' tools do in use. */
  readonly board: TaskBoard;
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
  /** Skill directories an agent's sessions have beyond the ones found in their directories. */
  readonly skillDirsFor: (meta: SessionMeta) => readonly string[];
  /**
   * The environment sessions' shells get beyond the process's: GitHub's login, once connected.
   * Empty when the host has no GitHub.
   */
  readonly shellEnv: NodeJS.ProcessEnv;
  /** The product's own HTTP routes (artifact pages, enrolling a machine); nothing for any other path. */
  fetch: (request: Request) => Promise<Response | undefined>;
  /** Where `sessions.*` actions for sessions on other machines go. */
  readonly remote: RemoteSessions;
  /** The product's own WebSocket routes: the link daemons dial. */
  readonly endpoints: readonly WebSocketEndpoint[];
  /** Cut the links to other machines and stop the bundles' services (the host is stopping). */
  close: () => Promise<void>;
}

/** The plugins are applied a moment after they are mounted; this is how long to wait for that. */
const MOUNT_TIMEOUT_MS = 10_000;

export function createProduct(options: {
  db: Database;
  dataDir: string;
  /** The memory sidecar's address. Without one there is no memory: no plugin, no tools, no calls. */
  memoryUrl?: string | undefined;
  /** The LLM gateway, once it is up (it starts after the product): bundles hand agents keys for it. */
  gateway?:
    | (() =>
        | (GatewayKeys & { revoke: (agentId: string) => Promise<void> })
        | undefined)
    | undefined;
  warn: (message: string) => void;
  /** The interface the host listens on, for the address a new machine is told to dial. */
  hostname?: string | undefined;
  /** The agent's home, where the user's own persona cards are. Defaults to the real one. */
  home?: string | undefined;
  routines?: RoutinesOptions;
  tasks?: TasksOptions;
  /** Overrides of what a published site may hold. */
  artifactLimits?: Partial<SiteLimits> | undefined;
  /** The address the user's browser reaches the host at, for MCP sign-in callbacks. */
  publicUrl?: string | undefined;
  /**
   * The GitHub chain: `true` loads it, and a `GithubTuning` (where GitHub is and what time it is,
   * for a test with a fake GitHub) loads it pointed at that. Absent or false means none of it:
   * no plugin, no tools, no callbacks, no login, and nothing asked of GitHub.
   */
  github?: boolean | GithubTuning | undefined;
  /**
   * `web_fetch` and `web_search`, run in this process. Absent means neither tool; `{}` is both,
   * searching with the SearXNG the host runs itself where a prebuilt one exists.
   */
  web?: Omit<WebOptions, "warn"> | undefined;
}): Product {
  const { db, dataDir, warn } = options;
  const memory =
    options.memoryUrl === undefined || options.memoryUrl === ""
      ? undefined
      : new MemoryClient(options.memoryUrl);
  // GitHub is one chain — the App, its plugin, its tools, the callbacks, the login on this machine
  // — so it is taken whole or left whole, and left by default. A host that wants it says so
  // (`--github`, `ETA_GITHUB`); a test says the same by handing over its fake, or plain `true`.
  // Leaving it also means not waiting for it: a plugin that is never mounted cannot be one of the
  // ones `mount` holds the startup up for.
  const githubOn =
    options.github === true || typeof options.github === "object";
  const githubTuning =
    typeof options.github === "object" ? options.github : undefined;
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
  // And a message whose lane was in that run is not waiting for anything any more.
  timeline.releaseHeld();
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
  // The task board's rows. A task's session is held in `task:<id>` (`tasks/session-key.ts`), which
  // its runs share; what counts it, asks about it or remembers it knows it by the conversation the
  // task came from.
  const taskRows = new TaskStore(db);
  const runRows = new TaskRunStore(db);
  const originOf = (meta: SessionMeta): SessionMeta => {
    const taskId = taskOfKey(
      meta.conversationId,
      (runId) => runRows.get(runId)?.taskId,
    );
    if (taskId === undefined) return meta;
    return {
      ...meta,
      conversationId: taskRows.get(taskId)?.originConversationId ?? undefined,
    };
  };
  // A model request ended, for a session of this host or of a daemon: count it.
  const generated = (meta: SessionMeta, message: AssistantMessage): void => {
    try {
      usage.record(
        entryOf(originOf(meta), message, runner.routineOf(meta) ?? null),
      );
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
    taskRunner?: TaskRunner;
    hooks?: Required<SessionHooks>;
    inbox?: Inbox;
    githubCredentials?: () => Promise<GitHubCredentials | null>;
    githubLogin?: GitHubKeeper;
  } = {};
  const hub = new MachineHub({
    machines,
    changed: () => {
      wire?.pushNow("machines");
      // A machine that came up may be the one a run was waiting for.
      later.taskRunner?.pump();
    },
    warn,
    serve: (link) =>
      serveLink(link, {
        taskRun: (session) => {
          const run = runRows.bySession(session);
          const task = run === undefined ? undefined : taskRows.get(run.taskId);
          if (
            run === undefined ||
            task?.createdBy.agentId == null ||
            run.machineId === null ||
            run.workspace === null
          )
            return undefined;
          return {
            // What the session is held in: the key it was made with, which is what the daemon
            // files its prompt and tools under, whatever run is working in it now.
            key: sessionKeyOf(run),
            agentId: task.createdBy.agentId,
            machineId: run.machineId,
            cwd: run.workspace,
          };
        },
        conversations,
        projects,
        machines,
        models: () => running?.models,
        hooks: () => later.hooks,
        approvals: () => later.inbox?.approvals() ?? [],
        githubCredentials: async () =>
          (await later.githubCredentials?.()) ?? null,
        generated,
        warn,
      }),
  });
  const mirrors = new SessionMirrors(hub, (id) => machines.get(id)?.name);
  // The bundles agents load: their files, values, services and the readiness of each machine.
  const secretKey = loadSecretKey(dataDir);
  const emailCredentials = new EmailCredentials(db, secretKey);
  const bundles = new Bundles({
    db,
    dataDir,
    key: secretKey,
    home: options.home ?? homedir(),
    machines,
    hub,
    agentBundles: (agentId) =>
      agentId === undefined ? [] : (agents.get(agentId)?.bundles ?? []),
    gateway: options.gateway,
    changed: () => wire?.pushNow("bundles"),
    warn,
  });
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
    bundles,
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
  const artifactRows = new ArtifactStore(db);
  const artifactsOf = (taskId: string) => artifactRows.latestOfTask(taskId);
  const board = new TaskBoard({
    db,
    tasks: taskRows,
    runs: runRows,
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
  // The GitHub App agents act as, and git and gh on this machine logged in as it (the daemons'
  // machines ask over their links; see `machines/service.ts`). None of it is there when the host
  // was started without GitHub: no App to act as, so no token to hand a machine either.
  const github: Github | undefined = githubOn
    ? new Github({
        db,
        key: secretKey,
        publicUrl: options.publicUrl,
        ...(githubTuning ?? {}),
        changed: () => {
          wire?.pushNow("github");
          void later.githubLogin?.poke();
          // The daemons' machines look again too, instead of at their next hourly refresh.
          for (const machine of machines.list())
            if (machine.kind === "daemon")
              void hub
                .link(machine.id)
                ?.machine("githubRefresh", {})
                .catch(() => undefined);
        },
        warn,
      })
    : undefined;
  /**
   * The token a machine's git and gh are set up with; null while GitHub is not connected, and
   * without a single request to GitHub while the host has no GitHub at all.
   */
  const githubCredentials = async (): Promise<GitHubCredentials | null> => {
    if (github === undefined) return null;
    try {
      return await github.credentials();
    } catch (error) {
      if (error instanceof GithubError) return null;
      throw error;
    }
  };
  const githubLogin =
    github === undefined
      ? undefined
      : new GitHubKeeper({
          dir: join(dataDir, "github"),
          credentials: githubCredentials,
          warn,
        });
  later.githubCredentials = githubCredentials;
  later.githubLogin = githubLogin;
  // Reading the web: pages and searches, for every session that has the tools.
  const web =
    options.web === undefined ? undefined : new Web({ ...options.web, warn });
  const attachments = new AttachmentStore(db, dataDir);
  const email = new EmailService(
    new EmailStore(db),
    emailCredentials,
    agents,
    projects,
    warn,
    { publicUrl: options.publicUrl },
  );
  const runHooks = combineRunHooks(
    memory === undefined ? [] : [memoryRunHooks(memory)],
  );
  const engine = new Engine({
    db,
    attachments,
    shell: (machine) => transportOn(machine, hub),
    models: () => running?.models,
    agents,
    machines,
    projects,
    conversations,
    timeline,
    changed,
    warn,
    remote: remotePlace,
    bundleStamp: (agent) => bundles.stampOf(agent.bundles),
    runHooks,
  });
  // The executors of tasks: a fresh session of the agent that made a task for each run, on the
  // machine of the task's project.
  const transport = (machine: MachineRecord) => transportOn(machine, hub);
  const taskRunner = new TaskRunner({
    board,
    tasks: taskRows,
    runs: runRows,
    agents,
    machines,
    projects,
    conversations,
    timeline,
    engine,
    transport,
    dataDir,
    hooks: runHooks,
    changed: (touched) => changed(touched),
    warn,
  });
  later.taskRunner = taskRunner;
  // Nothing is running yet, so the runs the last process left going cannot be.
  taskRunner.recover();

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
  /** GitHub's two returns to the host; with no GitHub, no path of its own answers. */
  const noRoutes = async (): Promise<Response | undefined> => undefined;
  const githubCallbacks =
    github === undefined ? noRoutes : githubRoutes(github, warn);

  // Each feature that adds tools, tool middleware or a question observer to sessions is one entry
  // here; the order is the order its tools and middleware are installed in.
  const productHooks: SessionHooks[] = [
    {
      sessionTools: engine.sessionTools,
      askObserve: engine.askObserve,
    },
    { sessionTools: runner.sessionTools },
    {
      sessionTools: taskSessionTools({
        board,
        agents,
        runner: taskRunner,
        workspaceFor: workspaceChooser({
          conversations,
          projects,
          machines,
          transport,
        }),
      }),
    },
    { sessionTools: artifactSessionTools({ artifacts, board, limits }) },
    // Without GitHub the tools are not there to offer: an agent's list does not mention them.
    ...(github === undefined
      ? []
      : [
          {
            sessionTools: githubSessionTools({
              github,
              opened: (conversationId, pull) => {
                // A task's session is held in its task's key (`tasks/session-key.ts`): its pull
                // request is that task's, whatever else the conversation or the board holds.
                const taskId =
                  taskOfKey(conversationId, (runId) =>
                    github.store.taskOfRun(runId),
                  ) ??
                  (conversationId === undefined
                    ? undefined
                    : github.store.taskOfConversation(conversationId));
                if (taskId === undefined) return;
                github.store.linkPull(taskId, pull, Date.now());
                wire?.pushNow("github");
              },
            }),
          },
        ]),
    {
      askObserve: (meta: SessionMeta) => inbox.askObserve(originOf(meta)),
    },
    { sessionTools: emailSessionTools(email) },
    ...(memory === undefined
      ? []
      : [
          {
            sessionTools: (input: Parameters<typeof memoryTools>[1]) =>
              memoryTools(memory, { ...input, meta: originOf(input.meta) }),
          },
        ]),
    ...(web === undefined ? [] : [{ sessionTools: webSessionTools(web) }]),
  ];
  // What the product's tools are, as a daemon's sessions get them (specs the daemon calls back).
  later.hooks = combineSessionHooks(productHooks);
  const sessionHooks = later.hooks;
  later.inbox = inbox;

  return {
    engine,
    board,
    hub,
    scheduler,
    sessionHooks,
    generated,
    skillDirsFor: (meta) => bundles.skillDirsFor(meta),
    shellEnv: githubLogin?.env ?? {},
    fetch: async (request) =>
      (await hub.enroll(request)) ??
      (await githubCallbacks(request)) ??
      (await bundles.route(request)) ??
      (await artifactRoutes(request)),
    remote: router,
    endpoints: [hub.endpoint],
    close: async () => {
      // The runs stop first: they work through the links and the session host.
      await taskRunner.detach();
      hub.close();
      mirrors.detach();
      githubLogin?.stop();
      email.stop();
      await bundles.close();
      await web?.close();
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
            [
              ...conversations.sessionsOn(machine.id),
              ...runRows.sessionsOn(machine.id),
            ].map((session) => ({ session, machineId: machine.id })),
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
        "bundles",
        "email",
        // Not mounted, so not waited for: github would otherwise cost the startup one
        // `MOUNT_TIMEOUT_MS` and then a failure.
        ...(github === undefined ? [] : ["github"]),
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
          {
            ...shared,
            dataDir,
            db,
            engine,
            changed,
            created,
            removed: (agentId) =>
              void options
                .gateway?.()
                ?.revoke(agentId)
                .catch((error) =>
                  warn(
                    `[eta] llm: could not end the keys of ${agentId}: ${String(error)}`,
                  ),
                ),
          },
          applied("agents"),
        ),
      );
      server.mount(
        "machines",
        machinesPlugin(
          {
            machines,
            hub,
            changed: () => {
              changed();
              // The limit may have moved: runs that were waiting for a slot can start.
              taskRunner.pump();
            },
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
          { ...shared, engine, attachments, targets, changed, created },
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
      server.mount(
        "tasks",
        tasksPlugin({ board, runner: taskRunner }, applied("tasks")),
      );
      server.mount(
        "artifacts",
        artifactsPlugin({ artifacts, board }, applied("artifacts")),
      );
      server.mount("inbox", inboxPlugin({ inbox }, applied("inbox")));
      server.mount(
        "email",
        emailPlugin(
          {
            service: email,
            projects,
            agents,
            conversations,
            engine,
            createdConversation: created,
          },
          applied("email"),
        ),
      );
      server.mount("usage", usagePlugin(usage, applied("usage")));
      server.mount(
        "bundles",
        bundlesPlugin(
          {
            registry: bundles.registry,
            rows: bundles.rows,
            services: bundles.services,
            readiness: bundles.readiness,
            changed: () => wire?.pushNow("bundles"),
          },
          applied("bundles"),
        ),
      );
      if (github !== undefined)
        server.mount("github", githubPlugin({ github }, applied("github")));
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
      bundles.start();
      // Everything the runs need is in place: the queue is looked at now.
      if (options.tasks?.runs !== false) taskRunner.attach();
      githubLogin?.start();
      // Where the App is installed, once, so the first look at the settings is not a guess.
      if (github !== undefined && github.app() !== null)
        void github.status(false).catch(() => undefined);
    },
  };
}
