import type { RuntimeCompaction } from "@eta/client-contracts";
import type {
  CompactionSummarizer,
  KernelModels,
  KernelTool,
  PersonaCard,
  ToolMiddleware,
} from "@eta/core";
import type { AnswerPayload } from "@eta/core/session";
import type {
  AskObserver,
  MemoryExtractionOutcome,
  OpenSession,
  PlatformGroup,
  PlatformPromptInfo,
  SessionMemoryOptions,
} from "@eta/harness";
import type {
  RuntimeExtras,
  SessionRuntime,
  SessionRuntimes,
} from "./runtimes";
import type { Settings } from "./settings";
import type { SessionListing, SessionMeta, SessionStore } from "./store";
import { join } from "node:path";
/**
 * SessionManager — several sessions in one process (REFACTOR.md §5b).
 *
 * What it owns, and why each part is here rather than in the harness:
 *
 * - **Identity and metadata.** A session exists because the store has a row for
 *   it; the manager picks the id and keeps the row's metadata with the open
 *   session, so a list can be rendered without opening anything.
 * - **Which sessions are open right now.** Opening is a decision with a cost (a
 *   journal replay, a kernel, its services), so it happens once per session and
 *   the handle is reused until the session is closed.
 * - **Sessions do not share anything.** Each one is a separate `openSession` and
 *   its own cordis root: its own kernel, bus, journal, usage and task ledger. Two
 *   sessions in the same directory are still two sessions, and one cannot hear the
 *   other's events (cordis dispatches a tree's events tree-wide, so sharing a root
 *   is exactly how two sessions would start writing into each other's journal).
 *
 * The harness does the assembly; this layer decides *when* to assemble, and what
 * to do with the result. The model layer is injected as a factory because
 * resolving a provider is the application's business — the manager only needs to
 * hand `openSession` something that can generate.
 */
import process from "node:process";
import { DEFAULT_COMPACTION_SETTINGS } from "@eta/core";
import { forkChain } from "@eta/core/session";
import {
  AskRegistry,
  nodeMemoryFs,
  openSession,
  renderRuntimePlatformBlock,
} from "@eta/harness";
import { forkWrites } from "./fork";
import { parseModelId } from "./model-id";
import { resolvePersona } from "./personas";

/**
 * Put tools on an open session, and make sure the model is offered them.
 *
 * The harness pins `activeToolNames` to the tools it installed, and a pinned set is what the runner
 * offers the model, so a tool registered afterwards exists in the service and reaches nobody. Only
 * the names that are missing are added: a session's config is restored from its journal, so a
 * second open already names them, and appending again would be a duplicate.
 */
export function registerSessionTools(
  session: OpenSession,
  tools: readonly KernelTool[],
): void {
  for (const tool of tools) session.kernel.tools.register(tool);
  const active = session.kernel.config.read("activeToolNames");
  const added = tools
    .map((tool) => tool.name)
    .filter((name) => !active.includes(name));
  if (added.length > 0 && active.length > 0) {
    session.kernel.config.update({ activeToolNames: [...active, ...added] });
  }
}

/** A session the manager has open. */
export interface ManagedSession {
  meta: SessionMeta;
  session: OpenSession;
}

export interface SessionManagerOptions {
  store: SessionStore;
  /**
   * The model layer for this session. Called once per open, with the metadata —
   * so which provider and model a session uses is the application's decision,
   * not the manager's.
   */
  modelsFor: (meta: SessionMeta) => KernelModels | Promise<KernelModels>;
  /** The summarizer a session compacts with; without one, a session runs unbound. */
  compaction?: CompactionSummarizer | undefined;
  /** What a new session's metadata starts as, beyond the id and the time. */
  defaults?:
    | Partial<Pick<SessionMeta, "persona" | "model" | "title">>
    | undefined;
  /**
   * What a new session starts as, read at the moment one is created.
   *
   * A function, not a value: the point of settings is that the *next* session gets what the
   * user just chose, and a snapshot taken when the manager was built would freeze the first
   * answer forever. Read here rather than in the plugin so every path that creates a session
   * inherits them.
   */
  settings?: (() => Promise<Settings>) | undefined;
  /**
   * The app's own facts for the platform briefing — paths only, per the harness's split. Absent
   * means the session is told nothing about the app around it, which is what a bare embedding
   * gets.
   */
  platformFor?:
    | ((meta: SessionMeta) => PlatformPromptInfo | undefined)
    | undefined;
  /**
   * The persona cards that apply to a session's working directory. The manager loads them into
   * the session (so the card's text is what the model reads) and re-resolves the session's own
   * card when a reload finds it gone. Absent means personas are the caller's business entirely.
   */
  personasFor?: ((meta: SessionMeta) => Promise<PersonaCard[]>) | undefined;
  /**
   * The rendered `<skills>` block for a session's working directory — discovery is the app's
   * (it knows the cwd, the home and the git roots); the block is the harness's. Read when the
   * session opens, and stable for its life, which is where the prompt layer wants it.
   */
  skillsFor?: ((meta: SessionMeta) => Promise<string>) | undefined;
  /**
   * What a session on an external runtime is given beyond the host's tools. Such a session has no
   * `skillsFor`: the runtime finds its own skills, and what is here is what it cannot find.
   */
  runtimeExtrasFor?:
    | ((meta: SessionMeta) => Promise<RuntimeExtras>)
    | undefined;
  /**
   * What a session on eta's own loop has under `eta.platform` beyond the tools, read when it opens.
   * Each group is closed with the session. `sessionDir` is the session's own directory.
   */
  platformGroupsFor?:
    | ((
        meta: SessionMeta,
        sessionDir: string,
      ) => Promise<readonly PlatformGroup[]>)
    | undefined;
  /** Where the app's files live, for the memory a session reads and writes. */
  memoryFor?:
    | ((meta: SessionMeta) => SessionMemoryWiring | undefined)
    | undefined;
  /**
   * Who the agent in a session is: its name, its place, its standing instructions. The harness's
   * base prompt is left alone; this lands in the platform section, after the persona and skills,
   * so it is where an app says what is true of *this* agent without owning the rest.
   */
  agentPromptFor?: ((meta: SessionMeta) => string | undefined) | undefined;
  /**
   * Middleware on a session's tool calls, read once when it opens.
   *
   * What a host wants on this seam is policy ("this tool asks before it runs"), and a session's
   * tools come into being here, so the policy arrives with them. Installed on the session's own
   * kernel, so it is disposed with the session.
   */
  toolMiddleware?:
    | ((input: { meta: SessionMeta; session: OpenSession }) => ToolMiddleware[])
    | undefined;
  /**
   * Tools a session gets beyond the harness's own, read once when it opens.
   *
   * The other half of the same seam: the host knows what this app has that the harness does not
   * (a task board, a way to reach other agents) and registers those as tools the model can call.
   * A session's toolset is fixed for its life rather than changing under a run.
   */
  sessionTools?:
    | ((input: { meta: SessionMeta; session: OpenSession }) => KernelTool[])
    | undefined;
  /**
   * What a host does with a session once it is assembled, before anything can run: the part of a
   * feature that needs the runner or the bus rather than the toolset (a plugin that watches the
   * generation, for one). Awaited, so a session never runs before its features are in place.
   */
  sessionAttach?:
    | ((input: { meta: SessionMeta; session: OpenSession }) => Promise<void>)
    | undefined;
  /**
   * How a session's questions are surfaced: told when one is asked, answered, canceled or
   * expired. Per session, because the answer is the session's own (who asked, in which
   * conversation). Absent means nobody is told.
   */
  askObserve?: ((meta: SessionMeta) => AskObserver | undefined) | undefined;
  /**
   * The external agent runtimes this host can run (`runtimes.ts`). A session whose metadata
   * names one has its runs taken by it; without this, such a session cannot be opened here.
   */
  runtimes?: SessionRuntimes | undefined;
  /** Called when a session cannot be opened; the list keeps its row either way. */
  warn?: ((message: string) => void) | undefined;
}

/** Where a session's memory is, and how an extraction reaches a model. */
export interface SessionMemoryWiring {
  home?: string | undefined;
  call?:
    | ((systemPrompt: string, prompt: string) => Promise<string>)
    | undefined;
  onExtraction?: ((outcome: MemoryExtractionOutcome) => void) | undefined;
}

/** What a caller supplies to branch a session off another one. */
export interface ForkSessionOptions {
  /** The entry to fork from; defaults to the source's tip. */
  entryId?: string | undefined;
  /** Whether the selected entry is part of the fork (default) or excluded. */
  position?: "before" | "at" | undefined;
  /** The destination's title; defaults to the source's, marked as a fork. */
  title?: string | undefined;
}

/** What a caller supplies to start a session. */
export interface CreateSessionOptions {
  /** The project the session works in. Defaults to the process's directory. */
  cwd?: string | undefined;
  /** The agent whose session this is, and the conversation it is held in (see `SessionMeta`). */
  agentId?: string | undefined;
  conversationId?: string | undefined;
  title?: string | undefined;
  persona?: string | undefined;
  model?: string | undefined;
  /**
   * The external runtime that answers in this session (see `SessionMeta.runtime`); absent, or
   * `eta`, means eta's own loop. Such a session takes no model or thinking level from the
   * settings: those name eta's models, and the runtime has its own.
   */
  runtime?: string | undefined;
}

export class SessionManager {
  private readonly store: SessionStore;
  private readonly modelsFor: SessionManagerOptions["modelsFor"];
  private readonly compaction: CompactionSummarizer | undefined;
  private readonly defaults: SessionManagerOptions["defaults"];
  private readonly settings: (() => Promise<Settings>) | undefined;
  private readonly platformFor: SessionManagerOptions["platformFor"];
  private readonly platformGroupsFor: SessionManagerOptions["platformGroupsFor"];
  /** The platform groups of the sessions that have some, by session. */
  private readonly groupsOf = new Map<string, readonly PlatformGroup[]>();
  private readonly personasFor: SessionManagerOptions["personasFor"];
  private readonly skillsFor: SessionManagerOptions["skillsFor"];
  private readonly runtimeExtrasFor: SessionManagerOptions["runtimeExtrasFor"];
  private readonly memoryFor: SessionManagerOptions["memoryFor"];
  private readonly agentPromptFor: SessionManagerOptions["agentPromptFor"];
  private readonly toolMiddleware: SessionManagerOptions["toolMiddleware"];
  private readonly sessionTools: SessionManagerOptions["sessionTools"];
  private readonly sessionAttach: SessionManagerOptions["sessionAttach"];
  private readonly askObserve: SessionManagerOptions["askObserve"];
  private readonly runtimes: SessionRuntimes | undefined;
  private readonly warn: (message: string) => void;
  private readonly open = new Map<string, ManagedSession>();
  /** The external runtime behind each open session that has one, let go when it closes. */
  private readonly runtimeOf = new Map<string, SessionRuntime>();

  constructor(options: SessionManagerOptions) {
    this.store = options.store;
    this.modelsFor = options.modelsFor;
    this.compaction = options.compaction;
    this.defaults = options.defaults;
    this.settings = options.settings;
    this.platformFor = options.platformFor;
    this.platformGroupsFor = options.platformGroupsFor;
    this.personasFor = options.personasFor;
    this.skillsFor = options.skillsFor;
    this.runtimeExtrasFor = options.runtimeExtrasFor;
    this.memoryFor = options.memoryFor;
    this.agentPromptFor = options.agentPromptFor;
    this.toolMiddleware = options.toolMiddleware;
    this.sessionTools = options.sessionTools;
    this.sessionAttach = options.sessionAttach;
    this.askObserve = options.askObserve;
    this.runtimes = options.runtimes;
    this.warn = options.warn ?? (() => undefined);
  }

  /** Start a session and open it, on whatever the settings say today. */
  async create(options: CreateSessionOptions = {}): Promise<ManagedSession> {
    const runtime =
      options.runtime === undefined || options.runtime === "eta"
        ? undefined
        : options.runtime;
    // The settings name eta's own models and levels; a runtime session has its own.
    const settings =
      runtime === undefined ? ((await this.settings?.()) ?? {}) : {};
    const persona =
      options.persona ?? this.defaults?.persona ?? settings.persona;
    const model =
      options.model ??
      (runtime === undefined ? this.defaults?.model : undefined) ??
      settings.model;
    const meta: SessionMeta = {
      id: newSessionId(),
      createdAt: Date.now(),
      cwd: options.cwd ?? settings.cwd ?? process.cwd(),
      ...((options.title ?? this.defaults?.title) === undefined
        ? {}
        : { title: (options.title ?? this.defaults?.title) as string }),
      ...(persona === undefined ? {} : { persona }),
      ...(model === undefined ? {} : { model }),
      ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
      ...(options.conversationId === undefined
        ? {}
        : { conversationId: options.conversationId }),
      ...(runtime === undefined ? {} : { runtime }),
    };
    await this.store.create(meta);
    return await this.openSession(meta, settings);
  }

  /**
   * The session behind an id, opening it the first time it is asked for.
   * `undefined` when the store has no such session; a session that is *there*
   * but cannot be opened is an error, because that is a bug worth hearing about.
   */
  async session(id: string): Promise<ManagedSession | undefined> {
    const already = this.open.get(id);
    if (already !== undefined) return already;
    const stored = await this.store.open(id);
    if (stored === undefined) return undefined;
    return await this.openSession(stored.meta);
  }

  /** Close a session: its journal is flushed, its services stopped, its slot freed. */
  async close(id: string): Promise<boolean> {
    const managed = this.open.get(id);
    if (managed === undefined) return false;
    this.open.delete(id);
    await this.disposeSession(managed);
    return true;
  }

  /** Every session the store knows about, newest first — including unreadable ones. */
  async list(): Promise<SessionListing[]> {
    return await this.store.list();
  }

  /**
   * Change what a session's row says — its title, whether it is pinned, whether it is
   * archived. `undefined` when there is no such session.
   *
   * Only the row moves: a running session keeps the model, tools and persona it is
   * already running with, because a rename is not a reconfiguration.
   */
  async setMeta(
    id: string,
    patch: Partial<Omit<SessionMeta, "id" | "createdAt" | "cwd">>,
  ): Promise<SessionMeta | undefined> {
    const live = this.open.get(id);
    const current = live?.meta ?? (await this.store.open(id))?.meta;
    if (current === undefined) return undefined;
    const next: SessionMeta = { ...current, ...patch };
    if (!(await this.store.save(next))) return undefined;
    // Keep the open handle's copy honest: `list()` and every state projection read it.
    if (live !== undefined) live.meta = next;
    return next;
  }

  /**
   * Branch a session off another one and open the result.
   *
   * The copied part is the source's history up to the chosen entry (the entry itself,
   * or its parent) plus the lane configuration it was left on. A fork is a new
   * session: it does not point back at the source, and it drops the source's task
   * list — see `fork.ts` for why those two in particular.
   */
  async fork(
    sourceId: string,
    options: ForkSessionOptions = {},
  ): Promise<ManagedSession> {
    const source = await this.session(sourceId);
    if (source === undefined) throw new Error(`no such session: ${sourceId}`);
    const chain = forkChain(source.session.log.graph, {
      ...(options.entryId === undefined ? {} : { entryId: options.entryId }),
      position: options.position ?? "at",
    });
    const meta: SessionMeta = {
      id: newSessionId(),
      createdAt: Date.now(),
      cwd: source.meta.cwd,
      title: options.title ?? titleForFork(source.meta.title),
      ...(source.meta.persona === undefined
        ? {}
        : { persona: source.meta.persona }),
      ...(source.meta.model === undefined ? {} : { model: source.meta.model }),
    };
    const created = await this.store.create(meta);
    await created.storage.commit(
      await forkWrites(source.session.log.storage, chain),
    );
    return await this.openSession(meta);
  }

  /**
   * Forget a session: close it if it is open, then take its row and its directory away.
   * Closing first matters — deleting a journal out from under an open handle is a leak the
   * runtime reports much later, far from here.
   */
  async remove(id: string): Promise<boolean> {
    await this.close(id);
    return await this.store.remove(id);
  }

  /**
   * `/compact` on a session an external runtime answers in: the runtime compacts its own context.
   * A runtime that offers no way to says so; only `completed` means it happened.
   */
  async compactRuntime(managed: ManagedSession): Promise<RuntimeCompaction> {
    const { id, runtime: runtimeId = "" } = managed.meta;
    const runtime = this.runtimeOf.get(id);
    return (
      (await runtime?.compact?.(managed.session.kernel.config.get())) ?? {
        runtime: runtimeId,
        outcome: "unsupported",
      }
    );
  }

  /** The sessions that are open right now. */
  openSessions(): ManagedSession[] {
    return [...this.open.values()];
  }

  /** Close everything this manager opened. */
  async closeAll(): Promise<void> {
    const managed = [...this.open.values()];
    this.open.clear();
    for (const session of managed) await this.disposeSession(session);
  }

  private async openSession(
    meta: SessionMeta,
    settings: Settings = {},
  ): Promise<ManagedSession> {
    if (meta.runtime !== undefined)
      return await this.openRuntimeSession(meta, meta.runtime);
    const models = await this.modelsFor(meta);
    const platform = this.platformFor?.(meta);
    const wiring = this.memoryFor?.(meta);
    const skills = await this.skillsFor?.(meta);
    const memory: SessionMemoryOptions | undefined =
      wiring === undefined
        ? undefined
        : {
            // Memory belongs to the project, and the project is on this machine's disk.
            fs: nodeMemoryFs(),
            cwd: meta.cwd,
            ...(wiring.home === undefined ? {} : { home: wiring.home }),
            ...(wiring.call === undefined ? {} : { call: wiring.call }),
            ...(wiring.onExtraction === undefined
              ? {}
              : { onExtraction: wiring.onExtraction }),
          };
    // Read once per open, like the settings: who hears about this session's questions is the
    // session's own answer, and it must not change under it while it runs.
    const observe = this.askObserve?.(meta);
    // The harness records an answer in the journal from its own registry. A host that wants to
    // watch the questions brings a registry (the seam the harness documents), and then it is
    // also the one recording answers, which needs the journal this very call builds: hence the
    // late binding. Nobody can answer before `openSession` returns, so nothing is lost.
    let recordAnswer: ((payload: AnswerPayload) => void) | undefined;
    const ask =
      observe === undefined
        ? true
        : new AskRegistry({
            observe,
            onAnswer: (payload) => recordAnswer?.(payload),
          });
    const agentPrompt = this.agentPromptFor?.(meta);
    const groups =
      platform?.sessionDir === undefined
        ? []
        : ((await this.platformGroupsFor?.(meta, platform.sessionDir)) ?? []);
    const session = await openSession({
      storage: (await this.store.open(meta.id))!.storage,
      models,
      // The ESM realm: scripts resolve in the project; the session's own directory is the
      // personal layer, the project's .eta the shared one, ~/.eta/global the global one.
      cwd: meta.cwd,
      sessionId: meta.id,
      ...(platform?.sessionDir === undefined
        ? {}
        : {
            esm: {
              root: platform.sessionDir,
              project: join(meta.cwd, ".eta"),
              global: join(platform.home, ".eta", "global"),
              groups,
            },
          }),
      ...(agentPrompt === undefined ? {} : { agentPrompt }),
      // The app's own facts: the words are the harness's, the paths are this app's.
      ...(platform === undefined ? {} : { platform }),
      ...(skills === undefined || skills.length === 0
        ? {}
        : { skillsSection: skills }),
      ...(memory === undefined ? {} : { memory }),
      ...(this.compaction === undefined ? {} : { compaction: this.compaction }),
      config: {
        ...(meta.model === undefined
          ? {}
          : { model: parseModelId(meta.model) }),
        // The settings a session was created with, for the parts that are kernel
        // configuration rather than metadata. They are written into the journal's config
        // during assembly, which is what makes them the session's own from then on: a
        // later change to settings reaches the next session, not this one.
        ...(settings.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: settings.thinkingLevel }),
        ...(settings.keepRecentTokens === undefined
          ? {}
          : {
              compaction: {
                ...DEFAULT_COMPACTION_SETTINGS,
                keepRecentTokens: settings.keepRecentTokens,
              },
            }),
      },
      // The ask channel is part of a session here: questions are answered over the
      // wire (`sessions.answer`), and without a registry the model's own ask tool is
      // not installed at all.
      ask,
      // No shared root: each session is its own cordis scope, so its bus,
      // journaling, usage and goals cannot hear another session's events.
      kernel: { warn: this.warn },
    });
    if (observe !== undefined) {
      recordAnswer = (payload) => {
        void session.journaling.recordAnswer(payload);
      };
    }
    // The persona cards that apply here, and the one this session is on. A card that is gone
    // resolves to the fallback rather than leaving the session without one — the session keeps
    // its history either way, and a persona is one file.
    if (this.personasFor !== undefined) {
      const cards = await this.personasFor(meta);
      session.kernel.persona.loadCards(cards);
      if (meta.persona !== undefined) {
        const resolved = resolvePersona(
          new Map(cards.map((card) => [card.id, card])),
          meta.persona,
        );
        if (!resolved.exact)
          this.warn(
            `[eta-server] session ${meta.id}: persona ${meta.persona} is gone; using ${resolved.id}`,
          );
        session.kernel.persona.setActive([resolved.id]);
      }
    } else if (meta.persona !== undefined) {
      session.kernel.persona.setActive([meta.persona]);
    }
    // What the host adds to the toolset goes in before anything can run.
    for (const middleware of this.toolMiddleware?.({ meta, session }) ?? []) {
      session.kernel.tools.use(middleware);
    }
    const tools = this.sessionTools?.({ meta, session }) ?? [];
    registerSessionTools(session, tools);
    await this.sessionAttach?.({ meta, session });
    // A session the host opened is a session whose inbox becomes runs: the pump is what
    // decides that, and leaving it off would make "prompt a session nobody attached yet"
    // (a session from the store) quietly do nothing.
    session.pump.start();
    const managed: ManagedSession = { meta, session };
    this.open.set(meta.id, managed);
    if (groups.length > 0) this.groupsOf.set(meta.id, groups);
    return managed;
  }

  /**
   * A session an external runtime answers in. It is assembled like any other (journal, bus,
   * inbox, the host's tools) with the runtime's delegate taking its runs, and without the parts
   * that are the runtime's own business: no file and shell tools, no memory, no compaction, no
   * subagents. The runtime has all of those itself; `/compact` asks it (`compactRuntime`).
   *
   * The runtime keeps its own system prompt, so the words of eta's it needs reach it through
   * `agentPrompt`, the platform briefing written for it among them.
   */
  private async openRuntimeSession(
    meta: SessionMeta,
    runtimeId: string,
  ): Promise<ManagedSession> {
    const tools: { names: readonly string[] } = { names: [] };
    const agentPrompt = this.agentPromptFor?.(meta);
    const platform = this.platformFor?.(meta);
    const extras = await this.runtimeExtrasFor?.(meta);
    const runtime = this.runtimes?.open({
      sessionId: meta.id,
      runtime: runtimeId,
      cwd: meta.cwd,
      resume: meta.runtimeSession,
      mcpServers: extras?.mcpServers,
      launchArgs: extras?.launchArgs,
      // Same channel, same order as an eta session's platform section: who it is, then the app.
      agentPrompt: () => {
        const parts = [
          ...(agentPrompt === undefined ? [] : [agentPrompt]),
          renderRuntimePlatformBlock({
            configPath: platform?.configPath,
            sessionDir: platform?.sessionDir,
            tools: tools.names,
          }),
          ...(extras?.skills === undefined ? [] : [extras.skills]),
        ].filter((part) => part.length > 0);
        return parts.length === 0 ? undefined : parts.join("\n\n");
      },
      remember: (nativeSession) => {
        if (nativeSession === meta.runtimeSession) return;
        void this.setMeta(meta.id, { runtimeSession: nativeSession }).catch(
          (error: unknown) =>
            this.warn(
              `[eta-server] session ${meta.id}: could not remember ${runtimeId} session: ${String(error)}`,
            ),
        );
      },
      hostTools: () => tools.names,
    });
    if (runtime === undefined)
      throw new Error(`runtime_unavailable: ${runtimeId} does not run here`);
    try {
      const observe = this.askObserve?.(meta);
      let recordAnswer: ((payload: AnswerPayload) => void) | undefined;
      const ask =
        observe === undefined
          ? true
          : new AskRegistry({
              observe,
              onAnswer: (payload) => recordAnswer?.(payload),
            });
      // The host's own tools run here too. They reach the session's directory through the
      // tools' own cwd, not through an environment: eta's file and shell tools belong to the
      // runtime in such a session, not to the host.
      const session = await openSession({
        storage: (await this.store.open(meta.id))!.storage,
        models: runtime.models,
        ...(agentPrompt === undefined ? {} : { agentPrompt }),
        runner: { delegate: runtime.delegate },
        config:
          meta.model === undefined ? {} : { model: parseModelId(meta.model) },
        ask,
        kernel: { warn: this.warn },
      });
      if (observe !== undefined) {
        recordAnswer = (payload) => {
          void session.journaling.recordAnswer(payload);
        };
      }
      // The host attaches its tools and starts the pump, here as in an eta session.
      const hostTools = this.sessionTools?.({ meta, session }) ?? [];
      registerSessionTools(session, hostTools);
      await this.sessionAttach?.({ meta, session });
      session.pump.start();
      tools.names = hostTools.map((tool) => tool.name);
      const managed: ManagedSession = { meta, session };
      this.open.set(meta.id, managed);
      this.runtimeOf.set(meta.id, runtime);
      return managed;
    } catch (error) {
      await runtime.dispose().catch(() => undefined);
      throw error;
    }
  }

  private async disposeSession(managed: ManagedSession): Promise<void> {
    managed.session.pump.stop();
    try {
      await managed.session.journaling.flush();
    } catch (error) {
      this.warn(
        `[eta-server] could not flush ${managed.meta.id}: ${String(error)}`,
      );
    }
    managed.session.stop();
    await managed.session.kernel.dispose();
    const groups = this.groupsOf.get(managed.meta.id) ?? [];
    this.groupsOf.delete(managed.meta.id);
    await Promise.all(
      groups.map((group) =>
        group
          .close()
          .catch((error: unknown) =>
            this.warn(
              `[eta-server] could not close ${group.name} of ${managed.meta.id}: ${String(error)}`,
            ),
          ),
      ),
    );
    const runtime = this.runtimeOf.get(managed.meta.id);
    if (runtime !== undefined) {
      this.runtimeOf.delete(managed.meta.id);
      await runtime
        .dispose()
        .catch((error: unknown) =>
          this.warn(
            `[eta-server] could not release the runtime of ${managed.meta.id}: ${String(error)}`,
          ),
        );
    }
  }
}

/** The title a fork gets when the caller did not choose one. */
function titleForFork(title: string | undefined): string {
  return title === undefined || title.length === 0
    ? "forked session"
    : `${title} (fork)`;
}

/** A fresh session id in the shape the app has always used. */
export function newSessionId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `eta-${Date.now().toString(36)}${random}`;
}
