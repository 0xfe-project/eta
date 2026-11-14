import type { AssistantMessage } from "@earendil-works/pi-ai";
/**
 * The product: the stores, the engine, and the plugins that put them on the wire.
 *
 * It is made before the server (the engine's hooks are options of `assembleServer`) and mounted
 * on it afterwards: the plugins need the server's wire and its session host, which only exist
 * then. Between the two, the replies a dead process left in flight are failed, so nothing a client
 * is ever shown says `working` without something working.
 */
import type { AgentRuntimeInfo } from "@eta/client-contracts";
import type {
  AssembledServer,
  RemoteSessions,
  RuntimeExtras,
  SessionMeta,
  WebSocketEndpoint,
  WireService,
} from "@eta/server";
import type { Database } from "bun:sqlite";
import type { SiteLimits } from "./artifacts/files";
import type { DaemonBuilds } from "./machines/builds";
import type { SshRunner } from "./machines/install";
import type { MachineRecord } from "./machines/store";
import type { Tailscale } from "./machines/tailscale";
import type { McpHostOptions } from "./mcp/host";
import type { SessionHooks } from "./session-hooks";
import type { UpgradePluginOptions } from "./upgrade/plugin";
import type { WebOptions } from "./web/service";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { peerAddressOf, redactionMiddleware } from "@eta/server";
import { agentsPlugin } from "./agents/plugin";
import { AgentStore } from "./agents/store";
import { approvalMiddleware } from "./approval-middleware";
import { loadKey } from "./artifacts/capability";
import { DEFAULT_LIMITS } from "./artifacts/files";
import { KINDS } from "./artifacts/kinds";
import { artifactsPlugin } from "./artifacts/plugin";
import { createArtifactRoutes } from "./artifacts/routes";
import { ArtifactService } from "./artifacts/service";
import { ArtifactStore } from "./artifacts/store";
import { artifactSessionTools } from "./artifacts/tools";
import { CaptainAudit } from "./captain/audit";
import { CaptainMemory } from "./captain/memory";
import { repairCaptainToolPin } from "./captain/pin";
import { captainPlugin } from "./captain/plugin";
import { redactToolResult } from "./captain/redact";
import { CaptainService } from "./captain/service";
import { CaptainStore } from "./captain/store";
import { CaptainSupervisor } from "./captain/supervisor";
import { captainSessionTools } from "./captain/tools";
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
import { Inbox } from "./inbox/inbox";
import { inboxPlugin } from "./inbox/plugin";
import { SettingStore } from "./inbox/setting";
import { InteractionStore } from "./inbox/store";
import { MachineHub } from "./machines/hub";
import { sshRunner } from "./machines/install";
import { SessionMirrors } from "./machines/mirror";
import { machinesPlugin } from "./machines/plugin";
import { RemotePlace } from "./machines/remote-place";
import { RemoteSessionsRouter } from "./machines/remote-sessions";
import { serveLink } from "./machines/service";
import { transportOn } from "./machines/shell";
import { MachineStore } from "./machines/store";
import { mcpPlugin } from "./mcp/plugin";
import { McpService } from "./mcp/service";
import { MemoryClient } from "./memory/client";
import { memoryRunHooks, memoryTools } from "./memory/hooks";
import { memoryPlugin } from "./memory/plugin";
import { pluginsPlugin } from "./plugins/plugin";
import { Plugins } from "./plugins/service";
import { pluginSessionTools } from "./plugins/tools";
import { checkDirectory } from "./projects/check";
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
import { isTaskSession, sessionKeyOf, taskOfKey } from "./tasks/session-key";
import { TaskStore } from "./tasks/store";
import { taskSessionTools } from "./tasks/tools";
import { workspaceChooser } from "./tasks/workspace";
import { busyAgents } from "./upgrade/database";
import { upgradePlugin, upgradeRoutes } from "./upgrade/plugin";
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
  /** El Capitan's product service and its supervisor. */
  readonly captain: CaptainService;
  readonly captainSupervisor: CaptainSupervisor;
  /** The routines' clock; `tick()` makes it look. */
  readonly scheduler: Scheduler;
  /** Every feature's per-session hooks, combined into the one set the session manager takes. */
  readonly sessionHooks: Required<SessionHooks>;
  /** Whether long-term/project memory is enabled for a session. */
  readonly memoryEnabledFor: (meta: SessionMeta) => boolean;
  /** The versioned base system prompt Captain can manage. */
  readonly baseSystemPromptFor: () => string;
  /** Count a model request that ended; the server tells it for every session it holds. */
  readonly generated: (meta: SessionMeta, message: AssistantMessage) => void;
  /** Mount the plugins on an assembled server; resolves when every one of them is in place. */
  mount: (server: AssembledServer) => Promise<void>;
  /** Skill directories an agent's sessions have beyond the ones found in their directories. */
  readonly skillDirsFor: (meta: SessionMeta) => readonly string[];
  /** What a session on an external runtime gets from the agent's plugins. */
  readonly runtimeExtrasFor: (meta: SessionMeta) => Promise<RuntimeExtras>;
  /** MCP on this machine (servers, credentials, sign-ins). */
  readonly mcp: McpService;
  /** The product's own HTTP routes (artifact pages, enrolling a machine); nothing for any other path. */
  fetch: (request: Request) => Promise<Response | undefined>;
  /** Where `sessions.*` actions for sessions on other machines go. */
  readonly remote: RemoteSessions;
  /** The product's own WebSocket routes: the link daemons dial. */
  readonly endpoints: readonly WebSocketEndpoint[];
  /** Cut the links to other machines (the host is stopping). */
  close: () => Promise<void>;
}

/** What a test sets to run MCP against fakes; a real host leaves it alone. */
export interface McpTuning {
  fetch?: McpHostOptions["fetch"];
  manager?: McpHostOptions["manager"];
}

/** The plugins are applied a moment after they are mounted; this is how long to wait for that. */
const MOUNT_TIMEOUT_MS = 10_000;

export function createProduct(options: {
  db: Database;
  dataDir: string;
  /** The memory sidecar's address. Without one there is no memory: no plugin, no tools, no calls. */
  memoryUrl?: string | undefined;
  warn: (message: string) => void;
  /** The interface the host listens on, for the address a new machine is told to dial. */
  hostname?: string | undefined;
  /** The agent's home, where the user's own persona cards are. Defaults to the real one. */
  home?: string | undefined;
  routines?: RoutinesOptions;
  tasks?: TasksOptions;
  /** Whether this product starts Captain; tests that are not about Captain leave it off. */
  captain?: boolean | undefined;
  /** Overrides of what a published site may hold. */
  artifactLimits?: Partial<SiteLimits> | undefined;
  /** The address the user's browser reaches the host at, for MCP sign-in callbacks. */
  publicUrl?: string | undefined;
  /** The token the gate asks for, when there is a gate. */
  accessToken?: string | undefined;
  /**
   * `web_fetch` and `web_search`, run in this process. Absent means neither tool; `{}` is both,
   * searching with the SearXNG the host runs itself where a prebuilt one exists.
   */
  web?: Omit<WebOptions, "warn"> | undefined;
  /** The external runtimes the primary machine has, with their models, for the agent editor. */
  runtimes?: ((fresh: boolean) => Promise<AgentRuntimeInfo[]>) | undefined;
  /**
   * Tailscale on this host: discovery of the tailnet's nodes, the address new machines dial, and
   * letting the user's own nodes in without a fingerprint. Absent means the tailnet is not used.
   */
  tailscale?: Tailscale | undefined;
  /** The daemon builds this primary carries: daemons are kept at them and installed from them. */
  daemonBuilds?: DaemonBuilds | undefined;
  /** How a daemon is put on another computer; the user's `ssh` by default (a test fakes it). */
  ssh?: SshRunner | undefined;
  /** What the update button works with, for a test; the host's own by default. */
  upgrade?: Partial<UpgradePluginOptions> | undefined;
  /**
   * MCP for this machine's sessions and the settings page is always on; this is a test's tuning
   * (the library's fetch, pointed at a fake authorization server, and its manager).
   */
  mcp?: McpTuning | undefined;
}): Product {
  const { db, dataDir, warn } = options;
  const captainOn = options.captain !== false;
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
  // And a message whose lane was in that run is not waiting for anything any more.
  timeline.releaseHeld();
  const interactions = new InteractionStore(db);
  interactions.expirePending();
  // Settled questions are kept for 30 days, like usage; the ones just expired above are new.
  interactions.prune();
  // Usage is kept for 30 days; what is older goes now, and again once a day while the host runs.
  const usage = new UsageStore(db);
  usage.prune();

  let captainChangeObserver: (() => void) | undefined;

  /** Say that product state moved, to whoever is looking at it. */
  const changed = (touched?: readonly string[] | "all"): void => {
    captainChangeObserver?.();
    if (wire === undefined) return;
    // `mcp` lists each agent's servers, so it moves with the agents.
    for (const target of [
      "agents",
      "machines",
      "projects",
      "conversations",
      "plugins",
      "mcp",
    ])
      wire.pushNow(target);
    // Captain's identity, pauses, operations, settings and assignment summaries are product
    // state too. A mutation from the sidebar must not wait for the next board event to redraw.
    wire.pushNow("captain");
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
    captainSupervisor?: CaptainSupervisor;
    hooks?: Required<SessionHooks>;
    inbox?: Inbox;
  } = {};
  const hub = new MachineHub({
    machines,
    changed: () => {
      wire?.pushNow("machines");
      // A machine that came up may be the one a run was waiting for.
      later.taskRunner?.pump();
    },
    warn,
    builds: options.daemonBuilds,
    ...(options.tailscale === undefined
      ? {}
      : {
          identify: async (request: Request) => {
            const address = peerAddressOf(request);
            return address === undefined
              ? undefined
              : await options.tailscale!.ownNode(address);
          },
        }),
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
        generated,
        warn,
      }),
  });
  const mirrors = new SessionMirrors(hub, (id) => machines.get(id)?.name);
  const secretKey = loadSecretKey(dataDir);
  const emailCredentials = new EmailCredentials(db, secretKey);
  const mcp = new McpService({
    db,
    key: secretKey,
    dataDir,
    home: options.home ?? homedir(),
    agents: () => agents.list().map(({ id, name }) => ({ id, name })),
    publicUrl: options.publicUrl,
    changed: () => wire?.pushNow("mcp"),
    warn,
    ...options.mcp,
  });
  // The plugins agents use: what is on disk, what the user configured and what each may read.
  const plugins = new Plugins({
    db,
    dataDir,
    key: secretKey,
    agents,
    machines,
    hub,
    changed: () => {
      wire?.pushNow("plugins");
      wire?.pushNow("agents");
    },
    warn,
  });
  const router = new RemoteSessionsRouter({
    conversations,
    runs: runRows,
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
    plugins,
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
      agents,
      artifactsOf,
    }),
    conversations,
    agents,
    artifactsOf,
    changed,
  });
  const inbox = new Inbox({
    interactions,
    settings: new SettingStore(db),
    timeline,
    changed: () => {
      wire?.pushNow("inbox");
      captainChangeObserver?.();
    },
    warn,
  });
  const captainStore = new CaptainStore(db);
  const captainAudit = new CaptainAudit(dataDir);
  const captainMemory = new CaptainMemory({
    db,
    dataDir,
    agents,
    projects,
    conversations,
    client: memory,
  });
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
  const memoryPausedForSessionKey = (key: string | undefined): boolean => {
    if (key === undefined) return false;
    if (isTaskSession(key)) {
      const taskId = taskOfKey(key, (runId) => runRows.get(runId)?.taskId);
      if (taskId === undefined) return false;
      if (captainStore.isMemoryPaused("task", taskId)) return true;
      const origin = taskRows.get(taskId)?.originConversationId;
      return (
        origin !== null &&
        origin !== undefined &&
        captainStore.isMemoryPaused("conversation", origin)
      );
    }
    return captainStore.isMemoryPaused("conversation", key);
  };
  const runHooks = combineRunHooks(
    memory === undefined
      ? []
      : [
          memoryRunHooks(memory, (run) => {
            const taskRun = runRows.get(run.replyId);
            if (taskRun !== undefined) {
              if (captainStore.isMemoryPaused("task", taskRun.taskId))
                return false;
            }
            return !captainStore.isMemoryPaused(
              "conversation",
              run.conversationId,
            );
          }),
        ],
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
    pluginStamp: (agent) => plugins.stampOf(agent.id),
    pluginsRead: () => plugins.registry.refresh(),
    sessionStamp: (conversationId) =>
      `${memoryPausedForSessionKey(conversationId) ? ":memory-paused" : ""}:base:${
        captainStore.latestPrompt("global", "base")?.version ?? 0
      }`,
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
  const captain = new CaptainService({
    dataDir,
    home: options.home ?? homedir(),
    store: captainStore,
    audit: captainAudit,
    agents,
    machines,
    plugins,
    projects,
    conversations,
    timeline,
    attachments,
    inbox,
    memory: captainMemory,
    engine,
    created,
    board,
    tasks: taskRows,
    runs: runRows,
    runner: taskRunner,
    changed,
    warn,
    checkDirectory: (machine, path) => checkDirectory(machine, hub, path),
  });
  inbox.onOpened((interaction) => captain.inboxOpened(interaction));
  inbox.onSettled((interaction, sourceInteractionId) =>
    captain.inboxSettled(interaction, sourceInteractionId),
  );
  const captainSupervisor = new CaptainSupervisor({
    store: captainStore,
    audit: captainAudit,
    captain,
    board,
    runs: runRows,
    machines,
    runner: taskRunner,
    inbox,
    timer: options.routines?.timer ?? true,
    warn,
    changed: () => wire?.pushNow("captain"),
  });
  later.captainSupervisor = captainSupervisor;
  captainChangeObserver = () => captainSupervisor.requestTick();
  board.onChange(() => {
    captain.refreshAssignments();
    captainSupervisor.requestTick();
    wire?.pushNow("captain");
  });
  // Nothing is running yet, so the runs the last process left going cannot be.
  taskRunner.recover();

  const limits = { ...DEFAULT_LIMITS, ...options.artifactLimits };
  const artifactsRoot = join(dataDir, "artifacts");
  const artifacts = new ArtifactService({
    store: artifactRows,
    root: artifactsRoot,
    limits,
    kinds: KINDS,
    key: loadKey(join(artifactsRoot, ".preview-key")),
    changed: () => wire?.pushNow("artifacts"),
  });
  const artifactRoutes = createArtifactRoutes(artifacts);

  const answerCaptainInbox: Parameters<
    typeof captainSessionTools
  >[0]["answerInbox"] = async (interactionId, response) =>
    await inbox.answerWith(
      interactionId,
      response,
      async (sessionId, questionId, value) => {
        const machine = router.machineOf(sessionId);
        if (machine !== undefined) {
          const result = (await router.forward("answer", {
            session: sessionId,
            questionId,
            response: value,
          })) as { answered?: unknown } | undefined;
          return result?.answered === true;
        }
        const managed = await running?.sessions.session(sessionId);
        return managed?.session.ask?.answer(questionId, value) === true;
      },
    );

  // Each feature that adds tools, tool middleware or a question observer to sessions is one entry
  // here; the order is the order its tools and middleware are installed in.
  const productHooks: SessionHooks[] = [
    { toolMiddleware: approvalMiddleware(inbox) },
    {
      toolMiddleware: ({ meta }) =>
        captain.identity()?.agentId === meta.agentId
          ? [
              {
                name: "captain-redaction",
                after(_name, _args, result) {
                  return redactToolResult(result);
                },
              },
            ]
          : [],
    },
    {
      sessionTools: captainSessionTools({
        service: captain,
        agents,
        projects,
        conversations,
        timeline,
        board,
        tasks: taskRows,
        inbox,
        attachments,
        memory: captainMemory,
        server: () => running,
        router,
        answerInbox: answerCaptainInbox,
        dataDir,
      }),
      /**
       * Captain may not have the task and email tools (see `captain/pin.ts`), and a session's pin
       * outlives the build that wrote it: another build on this data directory installs them and
       * widens the pin, and the next Captain-aware open would then fail every run with
       * `configured_tools_unavailable`. Narrowing the pin here is what keeps Captain runnable.
       */
      sessionAttach: async ({ meta, session }) => {
        if (captain.identity()?.agentId !== meta.agentId) return;
        const dropped = repairCaptainToolPin(session);
        if (dropped.length > 0)
          warn(
            `[eta] session ${meta.id}: took tools Captain may not have off its pin: ${dropped.join(", ")}`,
          );
      },
    },
    {
      sessionTools: engine.sessionTools,
      askObserve: engine.askObserve,
      sessionAttach: engine.sessionAttach,
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
        captain: {
          isCaptain: (agentId) => captain.identity()?.agentId === agentId,
          assignmentFor: (conversationId, agentId) =>
            captain.assignmentForAgent(conversationId, agentId),
          taskCreated: (input) => captain.taskCreated(input),
        },
      }),
    },
    {
      sessionTools: artifactSessionTools({
        artifacts,
        board,
        limits,
        taskOfRun: (runId) => runRows.get(runId)?.taskId,
      }),
    },
    {
      sessionTools: pluginSessionTools({
        plugins,
        transportOf: (meta) => {
          // Where the session runs: its row knows, and a session with no row is this process's.
          const machineId =
            conversations.ofSession(meta.id)?.machineId ??
            runRows.bySession(meta.id)?.machineId;
          const machine =
            machineId === undefined || machineId === null
              ? machines.primary()
              : machines.get(machineId);
          if (machine === undefined) throw new Error("no such machine");
          return transport(machine);
        },
      }),
      toolMiddleware: ({ meta }) => [
        redactionMiddleware(() => plugins.redactionsFor(meta.agentId)),
      ],
    },
    {
      askObserve: (meta: SessionMeta) => inbox.askObserve(originOf(meta)),
    },
    {
      sessionTools: (input) =>
        captain.identity()?.agentId === input.meta.agentId
          ? []
          : emailSessionTools(email)(input),
    },
    ...(memory === undefined
      ? []
      : [
          {
            sessionTools: (input: Parameters<typeof memoryTools>[1]) =>
              memoryTools(
                memory,
                { ...input, meta: originOf(input.meta) },
                () => captain.memoryEnabled(input.meta),
              ),
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
    captain,
    captainSupervisor,
    scheduler,
    sessionHooks,
    memoryEnabledFor: (meta) => captain.memoryEnabled(meta),
    baseSystemPromptFor: () => captain.basePrompt(),
    generated,
    skillDirsFor: (meta) => plugins.skillDirsFor(meta),
    runtimeExtrasFor: (meta) => plugins.runtimeExtrasFor(meta),
    mcp,
    fetch: async (request) =>
      (await hub.route(request)) ??
      (await mcp.route(request)) ??
      (await artifactRoutes(request)) ??
      upgradeRoutes(request, dataDir),
    remote: router,
    endpoints: [hub.endpoint],
    close: async () => {
      // The runs stop first: they work through the links and the session host.
      captainSupervisor.stop();
      await taskRunner.detach();
      hub.close();
      mirrors.detach();
      plugins.close();
      email.stop();
      await mcp.close();
      await web?.close();
    },
    async mount(server) {
      running = server;
      wire = server.wire;
      if (captainOn) await captain.ensure();
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
        ...(captainOn ? ["captain"] : []),
        "routines",
        "tasks",
        "artifacts",
        "inbox",
        "usage",
        "email",
        "plugins",
        "mcp",
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
      await plugins.start();
      server.mount(
        "plugins",
        pluginsPlugin({ plugins, agents }, applied("plugins")),
      );
      server.mount(
        "agents",
        agentsPlugin(
          {
            ...shared,
            dataDir,
            db,
            engine,
            plugins,
            changed,
            created,
            runtimes: options.runtimes,
            machineRuntimes: async (machineId, fresh) => {
              const link = hub.link(machineId);
              if (link === undefined)
                throw new Error(
                  `${machines.get(machineId)?.name ?? machineId} is not online`,
                );
              const { runtimes } = await link.daemon(
                "runtimes",
                { fresh },
                { timeoutMs: 60_000 },
              );
              return runtimes;
            },
            capturePrompt: (input) => {
              captainStore.appendPromptVersion({
                subjectId: input.agentId,
                kind: input.kind,
                content: input.content,
                actorAgentId: input.actorAgentId,
              });
            },
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
            defaultUrl: async () =>
              await defaultDaemonUrl(
                options.hostname ?? "127.0.0.1",
                server.server.port,
                options.tailscale,
              ),
            tailnetUrl: async () =>
              await tailnetDaemonUrl(
                options.hostname ?? "127.0.0.1",
                server.server.port,
                options.tailscale,
              ),
            tailscale: options.tailscale,
            builds: options.daemonBuilds,
            ssh: options.ssh ?? sshRunner(join(dataDir, "run")),
            accessToken: options.accessToken,
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
      if (captainOn)
        server.mount(
          "captain",
          captainPlugin({ service: captain, changed }, applied("captain")),
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
      server.mount(
        "inbox",
        inboxPlugin(
          {
            inbox,
            visible: (interaction) =>
              interaction.status !== "pending" ||
              captain.assignmentForInbox(interaction) === undefined,
          },
          applied("inbox"),
        ),
      );
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
        "upgrade",
        upgradePlugin(
          {
            dataDir,
            busy: () => busyAgents(dataDir),
            settings: new SettingStore(db),
            ...options.upgrade,
          },
          applied("upgrade"),
        ),
      );
      server.mount("mcp", mcpPlugin({ service: mcp }, applied("mcp")));
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
      // Everything the runs need is in place: the queue is looked at now.
      if (options.tasks?.runs !== false) taskRunner.attach();
      if (captainOn) captainSupervisor.start();
    },
  };
}

/**
 * The address a new machine is told to dial when the user does not say. On a host that listens on
 * its tailnet address (or on every interface) and is on a tailnet, its MagicDNS name: what every
 * node of the tailnet can reach. Otherwise the interface it listens on, or the computer's name
 * when that is every interface.
 */
async function defaultDaemonUrl(
  bound: string,
  port: number,
  tailscale: Tailscale | undefined,
): Promise<string> {
  const tailnet = await tailnetDaemonUrl(bound, port, tailscale);
  if (tailnet !== undefined) return tailnet;
  if (bound === "0.0.0.0" || bound === "::")
    return `http://${hostname()}:${port}`;
  return `http://${bound.includes(":") ? `[${bound}]` : bound}:${port}`;
}

/** This host on its tailnet, by MagicDNS name, when it is on one and listens there. */
async function tailnetDaemonUrl(
  bound: string,
  port: number,
  tailscale: Tailscale | undefined,
): Promise<string | undefined> {
  const every = bound === "0.0.0.0" || bound === "::";
  const status = await tailscale?.status();
  if (status === undefined || !(every || status.self.addresses.includes(bound)))
    return undefined;
  const name = status.self.dnsName || status.self.addresses[0];
  if (name === undefined || name === "") return undefined;
  return `http://${name.includes(":") ? `[${name}]` : name}:${port}`;
}
