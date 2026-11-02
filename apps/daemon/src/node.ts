/**
 * The daemon's sessions: what runs on this machine when the primary says so.
 *
 * It is a small eta server with no socket of its own. It assembles what the upstream server
 * assembles for sessions (a context, the wire service, the session manager over a file store and
 * the sessions plugin) and nothing else: no providers, no settings, no database, no product
 * plugins. The primary reaches it over the link as the client of an ordinary eta pipe, so
 * `sessions.*` means here what it means anywhere, and `machine.*` is the little that a machine
 * adds: facts, a directory check, a script runner, and the two calls that bring a session in line
 * with an agent and run it.
 *
 * Sessions belong to this machine, not to the link. A link that drops leaves them (and their
 * journals) where they are; what they lose is the primary, so the next generation or product tool
 * call fails and the run says so.
 */
import type {
  DaemonInstall,
  DaemonServiceParams,
  DaemonServiceResults,
  GitHubCredentials,
  MachineActionArgs,
  MachineActionResults,
  OpenSessionArgs,
  ToolSpec,
} from "@eta/client-contracts";
import type { CallFrame, ServerFrame } from "@eta/client-wire-proto";
import type { KernelTool, PersonaCard, ThinkingLevel } from "@eta/core";
import type { AskObserver, OpenSession } from "@eta/harness";
import type { McpConfigSource } from "@eta/mcp";
import type { OarRuntimes } from "@eta/runtime-oar";
import type { SessionMeta, SessionsService, Socket } from "@eta/server";
import type { ActiveBundle } from "./bundle";
import type { Peer } from "./link/peer";
import type { McpHostOptions } from "./mcp-host";
import { Buffer } from "node:buffer";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { isAbsolute, join } from "node:path";
import process from "node:process";
import { LINK_PROTOCOL } from "@eta/client-contracts";
import { createLocalEnvironment } from "@eta/execution-node";
import { createRefreshDedupingFetch } from "@eta/mcp";
import {
  additionalConfigPathsFromEnv,
  AkhookSession,
  journalTriggerStore,
} from "@eta/plugin-akhook";
import { createOarRuntimes } from "@eta/runtime-oar";
import {
  createConnection,
  discoverPersonas,
  FileSessionStore,
  formatModelId,
  renderSkillsBlock,
  SessionManager,
  sessionsPlugin,
  WireService,
} from "@eta/server";
import { LocalTransport } from "@eta/ssh";
import { Context } from "cordis";
import {
  bundleHookLayer,
  bundleMcpServers,
  bundleSkillDirs,
  BundleStore,
  isConfigured,
  readBundle,
} from "./bundle";
import { GitHubKeeper } from "./github";
import { relayAuthProviderFor } from "./mcp-auth";
import { McpHost } from "./mcp-host";
import { ModelCatalog, remoteModels } from "./models";
import { Reports } from "./reports";
import { runAndWait } from "./run";
import { proxyTools } from "./tools";
import { daemonPlatform, installKind } from "./upgrade";

export interface DaemonNodeOptions {
  /** Where sessions live: `<dataDir>/sessions`. */
  dataDir: string;
  version: string;
  /**
   * The primary's address (`http(s)://host:port`), where its LLM gateway is reached under
   * `/llm`. Without it a session gets no gateway, and the MCP servers that need it are dropped.
   */
  primaryUrl?: string | undefined;
  /** The user-level akhook file on this machine; defaults to akhook's own path. */
  akhookUserConfig?: string | undefined;
  warn?: ((message: string) => void) | undefined;
  /** The user's home on this machine (personas, `~/.eta/mcp.json`); the real one by default. */
  home?: string | undefined;
  /** Overrides of the MCP library's manager, for a test. */
  mcp?: McpHostOptions["manager"];
  /** How this process was started; read from the environment by default. */
  install?: DaemonInstall | undefined;
  /**
   * Replace this daemon with the primary's build (`./upgrade`). Without it the daemon refuses; a
   * success is followed by the process exiting, which is the caller's to do.
   */
  upgrade?:
    | ((
        wanted: DaemonServiceParams["upgrade"],
      ) => Promise<DaemonServiceResults["upgrade"]>)
    | undefined;
  /** The external runtimes; oar's by default (a test hands in scripted ones). */
  runtimes?: OarRuntimes | undefined;
}

/** What the primary last said about one agent's session in one conversation. */
interface Opening {
  prompt: string;
  stamp: string;
  tools: readonly ToolSpec[];
  cards: PersonaCard[];
  /** The primary's akhook layers, as text. */
  akhook: { name: string; text: string }[];
  /** The bundles the agent loads, read from this machine's copies. */
  bundles: ActiveBundle[];
}

const keyOf = (conversationId: string, agentId: string): string =>
  `${conversationId}:${agentId}`;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A call's arguments, as an object; the wire carries untrusted JSON. */
function argsOf<T>(call: CallFrame): T {
  const value = call.args ?? {};
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`machine.${call.action} takes an object`);
  return value as T;
}

/** One thing that happened to a question, as the primary is told (`ask.observe`). */
interface QuestionReport {
  session: string;
  action: Parameters<AskObserver>[0];
  payload: Parameters<AskObserver>[1];
}

export class DaemonNode {
  readonly #options: DaemonNodeOptions;
  readonly #warn: (message: string) => void;
  readonly #ctx = new Context();
  readonly #wire: WireService;
  readonly #manager: SessionManager;
  readonly #store: FileSessionStore;
  readonly #catalog = new ModelCatalog();
  readonly #runtimes: OarRuntimes;
  readonly #mcp: McpHost;
  /** git and gh on this machine, logged in as the primary's GitHub App. */
  readonly #github: GitHubKeeper;
  /** The bundles the primary sent, by contents. */
  readonly #bundles: BundleStore;
  /** The openings the primary sent, by `conversation:agent`; read when a session opens. */
  readonly #openings = new Map<string, Opening>();
  /** What happened to the questions; kept for the next link when there is none. */
  readonly #reports: Reports<QuestionReport>;
  /** What each open session's prompt was read from, to know when it has to be opened again. */
  readonly #opened = new Map<string, string>();
  readonly #akhookSessions = new WeakMap<object, AkhookSession>();
  readonly #fibers: { dispose: () => Promise<void> }[] = [];
  #sessions: SessionsService | undefined;
  #peer: Peer | undefined;
  #current:
    | { socket: Socket; connection: ReturnType<typeof createConnection> }
    | undefined;
  #socketIds = 0;

  constructor(options: DaemonNodeOptions) {
    this.#options = options;
    this.#warn = options.warn ?? ((message) => console.warn(message));
    this.#reports = new Reports("ask.observe", this.#warn);
    const warn = this.#warn;
    this.#wire = new WireService(this.#ctx, { warn });
    this.#store = new FileSessionStore({
      root: join(options.dataDir, "sessions"),
      warn,
    });
    const home = options.home ?? homedir();
    this.#bundles = new BundleStore(join(options.dataDir, "bundles"));
    // The token is the primary's to give; what stays here is at most an hour old.
    this.#github = new GitHubKeeper({
      dir: join(options.dataDir, "github"),
      credentials: async () => {
        const peer = this.#peer;
        // Without the primary the login on disk stays as it is until the link is back.
        if (peer === undefined || peer.lost) return undefined;
        return (await peer.call(
          "github.credentials",
          {},
          { timeoutMs: 15_000 },
        )) as GitHubCredentials | null;
      },
      warn,
    });
    // Credentials are the primary's: a token this machine refreshes is saved there.
    this.#mcp = new McpHost({
      dataDir: options.dataDir,
      home,
      warn,
      authProviderFor: relayAuthProviderFor(() => this.#peer),
      fetch: createRefreshDedupingFetch(),
      manager: options.mcp,
    });
    this.#runtimes = options.runtimes ?? createOarRuntimes({ warn });
    this.#manager = new SessionManager({
      store: this.#store,
      // Claude Code, Codex, OpenCode, Pi: an agent on one of them runs it on this machine.
      runtimes: this.#runtimes,
      // Generation is the primary's: this is a model layer that asks it.
      modelsFor: (meta) =>
        remoteModels({
          session: meta.id,
          catalog: this.#catalog,
          peer: () => this.#peer,
        }),
      envFor: (meta) => {
        // The shells see GitHub's login the keeper maintains (`./github`).
        const env = createLocalEnvironment(meta.cwd, this.#github.env);
        return env === undefined ? undefined : { env };
      },
      personasFor: async (meta) => {
        const found = await discoverPersonas({ cwd: meta.cwd, home, warn });
        // The user's cards live on the primary; the ones it sent win a clash like a project's do.
        for (const card of this.#openingOf(meta)?.cards ?? [])
          found.set(card.id, card);
        return [...found.values()];
      },
      skillsFor: async (meta) => {
        const env = createLocalEnvironment(meta.cwd);
        if (env === undefined) return "";
        return await renderSkillsBlock({
          env,
          cwd: meta.cwd,
          home,
          extraDirs: (this.#openingOf(meta)?.bundles ?? []).flatMap(
            bundleSkillDirs,
          ),
          warn,
        });
      },
      agentPromptFor: (meta) => {
        const opening = this.#openingOf(meta);
        if (opening === undefined) return undefined;
        this.#opened.set(meta.id, opening.stamp);
        return opening.prompt;
      },
      sessionTools: (input): KernelTool[] => {
        const { meta } = input;
        const opening = this.#openingOf(meta);
        if (opening === undefined) return [];
        // The product's tools are the primary's; an MCP server starts here, with the session.
        return [
          ...proxyTools({
            session: meta.id,
            specs: opening.tools,
            peer: () => this.#peer,
          }),
          ...this.#mcp.sessionTools({
            ...input,
            bundles: this.#bundleSources(opening, meta),
            akhook: this.#akhook(input).middleware,
          }),
        ];
      },
      // The rules of the machine the session runs on (the user's file, the project's
      // `.akhook.yml` here), then the primary's: the same rules the primary's own sessions have.
      // A tool on the primary's approval list is asked about through the same question.
      toolMiddleware: (input) =>
        this.#openingOf(input.meta) === undefined
          ? []
          : [this.#akhook(input).middleware],
      sessionAttach: async (input) => {
        if (this.#openingOf(input.meta) === undefined) return;
        await this.#akhook(input).attach(input.session);
      },
      askObserve: (meta): AskObserver | undefined => {
        if (this.#openingOf(meta) === undefined) return undefined;
        return (action, payload) => {
          this.#reports.send({ session: meta.id, action, payload });
        };
      },
      warn,
    });
    // A frame goes to the one link there is, if it asked for it.
    this.#wire.attachSink((addressed) => {
      const current = this.#current;
      if (current === undefined) return;
      if (addressed.socketId !== undefined) {
        if (addressed.socketId === current.socket.id)
          current.connection.send(addressed.frame);
        return;
      }
      if (
        addressed.target === undefined ||
        this.#wire.state
          .subscriptions(current.socket.id)
          .includes(addressed.target)
      )
        current.connection.send(addressed.frame);
    });
  }

  /** Mount the sessions plugin and the machine actions; resolves when both are in place. */
  async start(): Promise<void> {
    mkdirSync(this.#options.dataDir, { recursive: true });
    let applied!: () => void;
    const ready = new Promise<void>((resolve) => {
      applied = resolve;
    });
    const mount = (plugin: unknown): void => {
      this.#fibers.push(
        this.#ctx.plugin(plugin as never, undefined as never) as unknown as {
          dispose: () => Promise<void>;
        },
      );
    };
    mount(sessionsPlugin({ manager: this.#manager }));
    mount({
      name: "machine",
      inject: ["wire", "sessions"],
      apply: (ctx: {
        wire: WireService;
        sessions: SessionsService;
        effect: (execute: () => () => void) => unknown;
      }) =>
        ctx.effect(() => {
          this.#sessions = ctx.sessions;
          const offs = this.#register(ctx.wire);
          applied();
          return () => {
            for (const off of offs.splice(0)) off();
          };
        }),
    });
    await ready;
  }

  /** A link came up: serve the primary on it. */
  attach(peer: Peer): { receive: (frame: unknown) => void; close: () => void } {
    this.#peer = peer;
    // Back on the link: the login is looked at again (and set up, if the link is new).
    void this.#github.poke();
    const socket: Socket = {
      id: ++this.#socketIds,
      send: (frame: ServerFrame) => peer.sendPipe(frame),
    };
    const connection = createConnection(socket, {
      wire: this.#wire,
      mounted: () => [],
      warn: this.#warn,
    });
    this.#current = { socket, connection };
    // The things that can take a while are not pipe calls, which a connection applies one at a
    // time: they are calls of their own, and a stop on the pipe can overtake them.
    peer.handle("run", async (raw) => {
      const { session, text, images } = raw as DaemonServiceParams["run"];
      const { managed } = await this.#service().open(session);
      return await runAndWait(managed, text, undefined, images);
    });
    peer.handle("exec", async (raw, { signal }) => {
      const args = raw as DaemonServiceParams["exec"];
      return await new LocalTransport().run(args.script, {
        ...(args.inputBase64 === undefined
          ? {}
          : { input: Buffer.from(args.inputBase64, "base64") }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        signal,
      });
    });
    peer.handle("upgrade", async (raw) => {
      const wanted = raw as DaemonServiceParams["upgrade"];
      if (this.#options.upgrade === undefined)
        return { ok: false, reason: "this daemon cannot replace itself" };
      return await this.#options.upgrade(wanted);
    });
    peer.handle("runtimes", async (raw) => {
      const { fresh } = (raw ?? {}) as DaemonServiceParams["runtimes"];
      return { runtimes: await this.#runtimes.catalog.list(fresh === true) };
    });
    // What the questions did while nobody was listening.
    this.#reports.attach(peer);
    return {
      receive: (frame) => void connection.handle(JSON.stringify(frame)),
      close: () => {
        connection.close();
        if (this.#current?.socket === socket) this.#current = undefined;
        if (this.#peer === peer) this.#peer = undefined;
        this.#reports.detach(peer);
      },
    };
  }

  /** Close the sessions and let go of the files. */
  async close(): Promise<void> {
    for (const fiber of this.#fibers.splice(0).reverse()) await fiber.dispose();
    await this.#manager.closeAll();
    await this.#github.stop();
    await this.#mcp.close();
    await this.#store.close();
  }

  #akhook(input: { meta: SessionMeta; session: OpenSession }): AkhookSession {
    let made = this.#akhookSessions.get(input.session);
    if (made === undefined) {
      const { meta, session } = input;
      made = new AkhookSession({
        cwd: meta.cwd,
        ask: session.ask,
        approvals: (name) => this.#needsApproval(meta.id, name),
        userConfigPath: this.#options.akhookUserConfig,
        additional: () => [
          ...additionalConfigPathsFromEnv(),
          ...(this.#openingOf(meta)?.akhook ?? []),
          ...(this.#openingOf(meta)?.bundles ?? []).flatMap((active) => {
            const layer = bundleHookLayer(active, { cwd: meta.cwd });
            return layer === undefined ? [] : [layer];
          }),
        ],
        store: journalTriggerStore(session),
        warn: this.#warn,
      });
      this.#akhookSessions.set(session, made);
    }
    return made;
  }

  /** The MCP servers of the bundles the agent loads, one source each. */
  #bundleSources(opening: Opening, meta: SessionMeta): McpConfigSource[] {
    return opening.bundles.map((active) => ({
      name: `bundle:${active.bundle.manifest.name}`,
      servers: bundleMcpServers(active, { cwd: meta.cwd }, this.#warn),
    }));
  }

  #openingOf(meta: SessionMeta): Opening | undefined {
    if (meta.agentId === undefined || meta.conversationId === undefined)
      return undefined;
    return this.#openings.get(keyOf(meta.conversationId, meta.agentId));
  }

  async #needsApproval(session: string, name: string): Promise<boolean> {
    const peer = this.#peer;
    if (peer === undefined || peer.lost)
      throw new Error("the primary is not reachable");
    const answer = (await peer.call(
      "tool.gate",
      { session, name },
      { timeoutMs: 15_000 },
    )) as { ask: boolean };
    return answer.ask;
  }

  /* ------------------------------------------------------------ machine.* */

  #register(wire: WireService): (() => void)[] {
    const handlers: {
      [A in keyof MachineActionArgs]: (
        args: MachineActionArgs[A],
      ) => Promise<MachineActionResults[A]> | MachineActionResults[A];
    } = {
      info: () => ({
        hostname: hostname(),
        home: homedir(),
        os: platform(),
        version: this.#options.version,
        protocol: LINK_PROTOCOL,
        platform: daemonPlatform(),
        install: this.#options.install ?? installKind(),
      }),
      stat: async ({ path }) => {
        if (!isAbsolute(path))
          return { ok: false, reason: `not absolute: ${path}` };
        const found = await stat(path).catch(() => undefined);
        if (found === undefined)
          return { ok: false, reason: `no such directory: ${path}` };
        if (!found.isDirectory())
          return { ok: false, reason: `not a directory: ${path}` };
        return { ok: true };
      },
      open: (args) => this.#open(args),
      catalog: ({ models }) => {
        for (const spec of models) this.#catalog.add(spec);
        return {};
      },
      bundleHave: ({ hashes }) => ({
        missing: hashes.filter((hash) => !this.#bundles.has(hash)),
      }),
      bundlePut: ({ hash, files }) => {
        this.#bundles.put(hash, files);
        return {};
      },
      which: ({ commands }) => ({
        found: commands.filter(
          (command) =>
            Bun.which(command, { PATH: process.env.PATH ?? "" }) !== null,
        ),
      }),
      githubRefresh: () => {
        void this.#github.poke();
        return {};
      },
      config: async ({ session }) => {
        const { managed } = await this.#service().open(session);
        const config = managed.session.kernel.config;
        return {
          model: formatModelId(config.read("model")),
          thinkingLevel: config.read("thinkingLevel"),
        };
      },
    };
    return (Object.keys(handlers) as (keyof MachineActionArgs)[]).map(
      (action) =>
        wire.handle("machine", action, async (call) => ({
          result: await (
            handlers[action] as (args: unknown) => Promise<unknown> | unknown
          )(argsOf(call)),
        })),
    );
  }

  /** The bundles an open names, from the copies kept here; one that is missing is left out. */
  #activeBundles(args: OpenSessionArgs): ActiveBundle[] {
    const active: ActiveBundle[] = [];
    const { primaryUrl } = this.#options;
    const gateway =
      args.gatewayKey === undefined || primaryUrl === undefined
        ? undefined
        : { url: `${new URL(primaryUrl).origin}/llm`, key: args.gatewayKey };
    for (const opened of args.bundles ?? []) {
      try {
        const bundle = readBundle(this.#bundles.dir(opened.hash));
        active.push({
          bundle,
          config: opened.config,
          configured:
            opened.configured && isConfigured(bundle.manifest, opened.config),
          gateway,
        });
      } catch (error) {
        this.#warn(
          `[eta-daemon] bundle ${opened.name} is not usable: ${messageOf(error)}`,
        );
      }
    }
    return active;
  }

  #service(): SessionsService {
    if (this.#sessions === undefined) throw new Error("the daemon is starting");
    return this.#sessions;
  }

  /**
   * Bring the session of one agent in one conversation in line with the agent: the one the
   * primary names, adjusted, or a new one made on the spot. The same steps the primary takes for
   * its own sessions, so an agent behaves the same wherever it runs.
   */
  async #open(args: OpenSessionArgs): Promise<{ session: string }> {
    const sessions = this.#service();
    if (args.modelSpec !== undefined) this.#catalog.add(args.modelSpec);
    this.#openings.set(keyOf(args.conversationId, args.agentId), {
      prompt: args.agentPrompt,
      stamp: args.stamp,
      tools: args.tools,
      cards: (args.personaCards ?? []) as PersonaCard[],
      akhook: args.akhook ?? [],
      bundles: this.#activeBundles(args),
    });
    const thinking = (id: string): Promise<unknown> =>
      args.thinkingLevel === undefined
        ? Promise.resolve()
        : sessions
            .thinkingLevel(id, args.thinkingLevel as ThinkingLevel)
            .catch((error: unknown) =>
              this.#warn(`[eta-daemon] ${messageOf(error)}`),
            );

    if (args.session !== undefined) {
      const id = args.session;
      try {
        const { managed } = await sessions.open(id);
        // A conversation is one runtime's: an agent that moved to another starts over.
        if ((managed.meta.runtime ?? "eta") !== (args.runtime ?? "eta"))
          throw new Error(`no such session on ${args.runtime ?? "eta"}: ${id}`);
        if (this.#opened.get(id) !== args.stamp) {
          await sessions.setMeta(id, {
            persona: args.persona === undefined ? undefined : args.persona,
          });
          await sessions.close(id);
          await sessions.open(id);
        }
        return { session: id };
      } catch (error) {
        // The row outlived its journal: start over rather than failing every wake.
        if (!messageOf(error).startsWith("no such session")) throw error;
        this.#warn(
          `[eta-daemon] session ${id} (agent ${args.agentId} in ${args.conversationId}) is gone; starting a new one`,
        );
      }
    }
    const id = await sessions.create({
      cwd: args.cwd,
      title: args.title,
      agentId: args.agentId,
      conversationId: args.conversationId,
      ...(args.runtime === undefined ? {} : { runtime: args.runtime }),
      ...(args.model === undefined ? {} : { model: args.model }),
      ...(args.persona === undefined ? {} : { persona: args.persona }),
    });
    await thinking(id);
    return { session: id };
  }
}
