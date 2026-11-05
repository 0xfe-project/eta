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
import type { AskObserver } from "@eta/harness";
import type { OarRuntimes } from "@eta/runtime-oar";
import type { SessionMeta, SessionsService, Socket } from "@eta/server";
import type { Peer } from "./link/peer";
import { Buffer } from "node:buffer";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { isAbsolute, join } from "node:path";
import { LINK_PROTOCOL } from "@eta/client-contracts";
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
import { GitHubKeeper } from "./github";
import { ModelCatalog, remoteModels } from "./models";
import { Reports } from "./reports";
import { lastSeq, runAndWait } from "./run";
import { proxyTools } from "./tools";
import { daemonPlatform, installKind } from "./upgrade";

export interface DaemonNodeOptions {
  /** Where sessions live: `<dataDir>/sessions`. */
  dataDir: string;
  version: string;
  warn?: ((message: string) => void) | undefined;
  /** The user's home on this machine (personas, `~/.eta/mcp.json`); the real one by default. */
  home?: string | undefined;
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
  /** git and gh on this machine, logged in as the primary's GitHub App. */
  readonly #github: GitHubKeeper;
  /** The openings the primary sent, by `conversation:agent`; read when a session opens. */
  readonly #openings = new Map<string, Opening>();
  /** What happened to the questions; kept for the next link when there is none. */
  readonly #reports: Reports<QuestionReport>;
  /** What each open session's prompt was read from, to know when it has to be opened again. */
  readonly #opened = new Map<string, string>();
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
      personasFor: async (meta) => {
        const found = await discoverPersonas({ cwd: meta.cwd, home, warn });
        // The user's cards live on the primary; the ones it sent win a clash like a project's do.
        for (const card of this.#openingOf(meta)?.cards ?? [])
          found.set(card.id, card);
        return [...found.values()];
      },
      skillsFor: async (meta) => {
        return await renderSkillsBlock({
          cwd: meta.cwd,
          home,
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
        // The product's tools are the primary's. (MCP servers and akhook rules started here
        // until they moved to TOBEREFR; see packages/TOBEREFR/TODO.md.)
        return proxyTools({
          session: meta.id,
          specs: opening.tools,
          peer: () => this.#peer,
        });
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
    await this.#store.close();
  }

  #openingOf(meta: SessionMeta): Opening | undefined {
    if (meta.agentId === undefined || meta.conversationId === undefined)
      return undefined;
    return this.#openings.get(keyOf(meta.conversationId, meta.agentId));
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
      lastSeq: async ({ session }) => {
        const { managed } = await this.#service().open(session);
        return { seq: lastSeq(managed) };
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
