import type {
  CompactionSummarizer,
  KernelModels,
  PersonaCard,
} from "@eta/core";
import type {
  ExecutionEnv,
  MemoryExtractionOutcome,
  MemoryFs,
  OpenSession,
  PlatformPromptInfo,
  SessionMemoryOptions,
  SubagentManager,
} from "@eta/harness";
import type { SessionEnvironment } from "@eta/plugin-sdk";
import type { Settings } from "./settings";
import type { SessionListing, SessionMeta, SessionStore } from "./store";
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
import { envMemoryFs, openSession } from "@eta/harness";
import { forkWrites } from "./fork";
import { parseModelId } from "./model-id";
import { resolvePersona } from "./personas";
import { sessionSubagentRunner } from "./subagent";

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
  /**
   * Whether a session can spawn subagents. On by default: a subagent is a session of its
   * own here, so the capability costs nothing new to explain. `false` means the subagent
   * tools are not installed at all — absent, not disabled.
   */
  subagents?: { poolSize?: number | undefined } | false | undefined;
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
   * inherits them — including a subagent's, which is created by the runner.
   */
  settings?: (() => Promise<Settings>) | undefined;
  /**
   * How a session's environment is decided — the file and shell tools it runs, and where its
   * memory lives.
   *
   * A function of the session's metadata, because the answer is per session: a session in a
   * remote workspace runs its tools over SSH, and one in a local directory runs them here. The
   * manager does not know what an environment *is*; it asks, and hands the answer to the
   * harness. Absent means no environment at all — a session with no read/write/edit/bash, which
   * is a legitimate session (a side thread, a sandbox).
   */
  envFor?: ((meta: SessionMeta) => SessionEnvironment | undefined) | undefined;
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
  /** Where the app's files live, for the memory a session reads and writes. */
  memoryFor?:
    | ((meta: SessionMeta) => SessionMemoryWiring | undefined)
    | undefined;
  /** Called when a session cannot be opened; the list keeps its row either way. */
  warn?: ((message: string) => void) | undefined;
}

export type { SessionEnvironment } from "@eta/plugin-sdk";

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
  title?: string | undefined;
  persona?: string | undefined;
  model?: string | undefined;
  /**
   * The subagent record this session's own pool acts as. Omitted for a root session; a
   * subagent passes its record id, which is what files a grandchild under it.
   */
  subagentOwner?: string | undefined;
  /** A pool to join: set by a subagent, which belongs to the tree that spawned it. */
  subagents?: SubagentManager | undefined;
}

export class SessionManager {
  private readonly store: SessionStore;
  private readonly modelsFor: SessionManagerOptions["modelsFor"];
  private readonly compaction: CompactionSummarizer | undefined;
  private readonly defaults: SessionManagerOptions["defaults"];
  private readonly settings: (() => Promise<Settings>) | undefined;
  private readonly envFor: SessionManagerOptions["envFor"];
  private readonly platformFor: SessionManagerOptions["platformFor"];
  private readonly personasFor: SessionManagerOptions["personasFor"];
  private readonly skillsFor: SessionManagerOptions["skillsFor"];
  private readonly memoryFor: SessionManagerOptions["memoryFor"];
  private readonly subagents: SessionManagerOptions["subagents"];
  private readonly warn: (message: string) => void;
  private readonly open = new Map<string, ManagedSession>();

  constructor(options: SessionManagerOptions) {
    this.store = options.store;
    this.modelsFor = options.modelsFor;
    this.compaction = options.compaction;
    this.subagents = options.subagents;
    this.defaults = options.defaults;
    this.settings = options.settings;
    this.envFor = options.envFor;
    this.platformFor = options.platformFor;
    this.personasFor = options.personasFor;
    this.skillsFor = options.skillsFor;
    this.memoryFor = options.memoryFor;
    this.warn = options.warn ?? (() => undefined);
  }

  /** Start a session and open it, on whatever the settings say today. */
  async create(options: CreateSessionOptions = {}): Promise<ManagedSession> {
    const settings = (await this.settings?.()) ?? {};
    const persona =
      options.persona ?? this.defaults?.persona ?? settings.persona;
    const model = options.model ?? this.defaults?.model ?? settings.model;
    const meta: SessionMeta = {
      id: newSessionId(),
      createdAt: Date.now(),
      cwd: options.cwd ?? settings.cwd ?? process.cwd(),
      ...((options.title ?? this.defaults?.title) === undefined
        ? {}
        : { title: (options.title ?? this.defaults?.title) as string }),
      ...(persona === undefined ? {} : { persona }),
      ...(model === undefined ? {} : { model }),
    };
    await this.store.create(meta);
    return await this.openSession(
      meta,
      options.subagentOwner,
      options.subagents,
      settings,
    );
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
    subagentOwner?: string,
    joined?: SubagentManager,
    settings: Settings = {},
  ): Promise<ManagedSession> {
    const models = await this.modelsFor(meta);
    // The pool a session runs its children through. A child joins its tree's; a root is
    // given a runner and the pool is built around it during assembly — which is why the
    // runner reads the pool lazily, through this box.
    const platform = this.platformFor?.(meta);
    const box: { pool?: SubagentManager } = {};
    const poolSize =
      this.subagents === false ? undefined : this.subagents?.poolSize;
    const subagentOptions: Record<string, unknown> =
      joined !== undefined
        ? {
            subagents: joined,
            ...(subagentOwner === undefined ? {} : { subagentOwner }),
          }
        : {
            subagentRunner: sessionSubagentRunner({
              manager: this,
              parent: meta,
              parentPool: () => box.pool,
              warn: this.warn,
            }),
            ...(subagentOwner === undefined ? {} : { subagentOwner }),
            ...(poolSize === undefined ? {} : { poolSize }),
          };
    const environment = this.envFor?.(meta);
    const wiring = this.memoryFor?.(meta);
    const skills = await this.skillsFor?.(meta);
    const memory: SessionMemoryOptions | undefined =
      wiring === undefined
        ? undefined
        : {
            // The environment's files, when there is one: memory belongs to the project, and a
            // session in a remote workspace reads *that* project's memory.
            fs: (environment?.memoryFs ??
              memoryFsFrom(environment?.env)) as MemoryFs,
            cwd: meta.cwd,
            ...(wiring.home === undefined ? {} : { home: wiring.home }),
            ...(wiring.call === undefined ? {} : { call: wiring.call }),
            ...(wiring.onExtraction === undefined
              ? {}
              : { onExtraction: wiring.onExtraction }),
          };
    const session = await openSession({
      storage: (await this.store.open(meta.id))!.storage,
      models,
      // The environment: what a session's tools run against, and where its memory lives. The
      // harness's tools were written against the seam, so a session across the room runs the
      // same read/write/edit/bash as one here.
      ...(environment === undefined ? {} : { env: environment.env }),
      // The app's own facts: the words are the harness's, the paths are this app's.
      ...(platform === undefined ? {} : { platform }),
      ...(skills === undefined || skills.length === 0
        ? {}
        : { skillsSection: skills }),
      ...(memory === undefined ? {} : { memory }),
      // Subagents: a session joins the pool of the tree that spawned it, or — when it is a
      // root — gets a runner, and the pool is built around it during assembly.
      ...(this.subagents === false ? {} : subagentOptions),
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
      ask: true,
      // No shared root: each session is its own cordis scope, so its bus,
      // journaling, usage and goals cannot hear another session's events.
      kernel: { warn: this.warn },
    });
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
    box.pool = session.subagents;
    // A session the host opened is a session whose inbox becomes runs: the pump is what
    // decides that, and leaving it off would make "prompt a session nobody attached yet"
    // (a subagent's own run, a session from the store) quietly do nothing.
    session.pump.start();
    const managed: ManagedSession = { meta, session };
    this.open.set(meta.id, managed);
    return managed;
  }

  private async disposeSession(managed: ManagedSession): Promise<void> {
    // A closing session stops what it spawned: nothing is orphaned when the thing that was
    // going to read the answer is gone — the same rule the pool applies to a parent that
    // settles on its own.
    for (const record of managed.session.subagents?.list() ?? []) {
      if (record.status !== "running" && record.status !== "queued") continue;
      try {
        managed.session.subagents?.stop(record.id, undefined);
      } catch (error) {
        this.warn(`[eta-server] could not stop ${record.id}: ${String(error)}`);
      }
    }
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
  }
}

/**
 * Memory through an environment.
 *
 * `envMemoryFs` is the harness's adapter, and it needs an `ExecutionEnv`; a session with no
 * environment has no memory to read, which the caller expresses by not asking for any.
 */
function memoryFsFrom(env: ExecutionEnv | undefined): MemoryFs {
  if (env === undefined) {
    return {
      readFile: async () => undefined,
      mtime: async () => undefined,
      writeFile: async () => undefined,
      listFileNames: async () => [],
    };
  }
  return envMemoryFs(env);
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
