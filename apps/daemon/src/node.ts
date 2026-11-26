/**
 * The daemon's sessions: what runs on this machine when the primary says so.
 *
 * It is a small eta server with no socket of its own. It assembles what the upstream server
 * assembles for sessions (a context, the wire service, the session manager over a file store and
 * the sessions plugin) and nothing else: no providers, no settings, no database, no product
 * plugins. The primary reaches it over the link as the client of an ordinary eta pipe, so
 * `sessions.*` means here what it means anywhere, and `machine.*` is the little that a machine
 * adds: facts, its directories (`@eta/places`), a script runner, and the two calls that bring a session in line
 * with an agent and run it.
 *
 * Sessions belong to this machine, not to the link. A link that drops leaves them (and their
 * journals) where they are; what they lose is the primary, so the next generation or product tool
 * call fails and the run says so.
 */
import type {
  DaemonInstall,
  DaemonRunEvent,
  DaemonServiceParams,
  DaemonServiceResults,
  MachineActionArgs,
  MachineActionResults,
  OpenSessionArgs,
  Redaction,
  RunOutcome,
  SessionMcpServer,
  ToolSpec,
} from "@eta/client-contracts";
import type { CallFrame, ServerFrame } from "@eta/client-wire-proto";
import type { KernelTool, PersonaCard, ThinkingLevel } from "@eta/core";
import type { AskObserver } from "@eta/harness";
import type { McpManagerOptions } from "@eta/mcp";
import type { AcpRuntimes } from "@eta/runtime-acp";
import type {
  ListedRuntimes,
  ManagedSession,
  SessionMeta,
  SessionsService,
  Socket,
} from "@eta/server";
import type { Peer } from "./link/peer";
import type { ActivePlugin } from "./plugin-launch";
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { LINK_LIMITS, LINK_PROTOCOL } from "@eta/client-contracts";
import { kernelOn } from "@eta/core";
import { createRefreshDedupingFetch } from "@eta/mcp";
import { Places } from "@eta/places";
import { AcpAdmin, createAcpRuntimes } from "@eta/runtime-acp";
import { createOarRuntimes } from "@eta/runtime-oar";
import {
  composeRuntimes,
  createConnection,
  discoverPersonas,
  FileSessionStore,
  formatModelId,
  redactionMiddleware,
  renderSkillsBlock,
  SessionManager,
  sessionsPlugin,
  SkillFiles,
  WireService,
} from "@eta/server";
import { LocalTransport } from "@eta/ssh";
import { Context } from "cordis";
import { relayAuthProviderFor } from "./mcp-auth";
import { McpHost } from "./mcp-host";
import { ModelCatalog, remoteModels } from "./models";
import { PluginStore } from "./plugin-files";
import {
  pluginMcpSources,
  runtimeExtras,
  withSessionServers,
} from "./plugin-launch";
import { loadPlugin } from "./plugin-package";
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
  /**
   * The external runtimes. By default oar's, and the ACP agents this machine's own
   * `~/.eta/acp.json` lists: an agent process runs where its session is, so what can run here is
   * what is configured here. (A test hands in scripted ones.)
   */
  runtimes?: ListedRuntimes | undefined;
  /**
   * The ACP agents the settings page edits on this machine (`acp*` calls). By default the ones
   * the default runtimes run; with `runtimes` handed in, none unless given here too.
   */
  acp?: AcpRuntimes | undefined;
  /** The fetch of MCP's HTTP transports and token requests (a test reaches a fake server). */
  mcpFetch?: McpManagerOptions["fetch"] | undefined;
  /** Overrides of the MCP library's manager, for a test. */
  mcp?: Partial<McpManagerOptions> | undefined;
  /** This machine's directories; a test hands in a Windows filesystem or a scripted git. */
  places?: Places | undefined;
}

/** What the primary last said about one agent's session in one conversation. */
interface Opening {
  prompt: string;
  stamp: string;
  tools: readonly ToolSpec[];
  cards: PersonaCard[];
  /** The agent's plugins, read from this machine's copies. */
  plugins: ActivePlugin[];
  /** The servers the primary named for an external runtime, beyond the plugins'. */
  servers: readonly SessionMcpServer[];
  redact: readonly Redaction[];
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
  readonly #skillFiles: SkillFiles;
  readonly #options: DaemonNodeOptions;
  readonly #warn: (message: string) => void;
  readonly #ctx = new Context();
  readonly #wire: WireService;
  readonly #manager: SessionManager;
  readonly #store: FileSessionStore;
  readonly #catalog = new ModelCatalog();
  readonly #runtimes: ListedRuntimes;
  /** This machine's `~/.eta/acp.json`, as the primary's settings page edits it. */
  readonly #acp: AcpAdmin | undefined;
  /** MCP for the sessions on eta's own loop; its OAuth credentials are the primary's. */
  readonly #mcp: McpHost;
  /** The plugins the primary sent, by contents. */
  readonly #plugins: PluginStore;
  /** This machine's directories, answered here (`@eta/places`), as the primary answers its own. */
  readonly #places: Places;
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
    this.#plugins = new PluginStore(join(options.dataDir, "plugins", "store"));
    this.#places = options.places ?? new Places({ home, os: platform() });
    // Use the same home this node advertises to the primary.
    this.#skillFiles = new SkillFiles(this.#places.rules.home);
    const acp =
      options.acp ??
      (options.runtimes === undefined
        ? createAcpRuntimes({
            configPath: join(home, ".eta", "acp.json"),
            warn,
          })
        : undefined);
    this.#acp = acp === undefined ? undefined : new AcpAdmin({ acp });
    this.#runtimes =
      options.runtimes ??
      composeRuntimes([createOarRuntimes({ warn }), ...(acp ? [acp] : [])]);
    this.#mcp = new McpHost({
      dataDir: options.dataDir,
      home,
      warn,
      // Credentials are the primary's: a token this machine refreshes is saved there.
      authProviderFor: relayAuthProviderFor(() => this.#peer),
      fetch: options.mcpFetch ?? createRefreshDedupingFetch(),
      // The plugins the primary opened this agent's session in this conversation with, and the
      // values it sent for their servers; nothing for the status page, which is the primary's.
      pluginSources: ({ agentId, conversationId }) => {
        if (conversationId === undefined) return [];
        const opening = this.#openings.get(keyOf(conversationId, agentId));
        if (opening === undefined || opening.plugins.length === 0) return [];
        return pluginMcpSources(opening.plugins, options.dataDir, warn);
      },
      manager: options.mcp,
    });
    this.#manager = new SessionManager({
      store: this.#store,
      // Claude Code, Codex, OpenCode, Pi, Antigravity, Grok Build, Qwen Code: an agent on one of
      // them runs it on this machine.
      runtimes: this.#runtimes,
      // Generation is the primary's: this is a model layer that asks it.
      modelsFor: (meta) =>
        remoteModels({
          session: meta.id,
          catalog: this.#catalog,
          peer: () => this.#peer,
        }),
      // The realm and the platform briefing of eta's own loop, as the primary gives its own
      // sessions (`@eta/server`'s `platformFor`): scripts run on this machine, in the session's
      // directory here. The config line is left out: the providers are the primary's.
      platformFor: (meta) => {
        if (meta.runtime !== undefined) return undefined;
        const target = join(meta.cwd, ".eta", "MEMORY.md");
        return {
          cwd: meta.cwd,
          home,
          sessionDir: join(options.dataDir, "sessions", meta.id),
          memoryTarget: target,
          memoryExists: existsSync(target),
        };
      },
      // The project's memory is read here, where the project is; nothing extracts to it yet.
      memoryFor: () => ({ home }),
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
          extraDirs: this.#skillDirsOf(meta),
          warn,
        });
      },
      // `import "mcp:<server>"` in eta's own loop: the agent's plugins, the user's file and the
      // project's, as on the primary. A server starts on this machine, with the session.
      mcpFor: (meta) => this.#mcp.sessionMcp(meta),
      // The agent's plugins, then what the primary named beyond them (its Composio toolkits).
      runtimeExtrasFor: async (meta) => {
        const opening = this.#openingOf(meta);
        return withSessionServers(
          await runtimeExtras(opening?.plugins ?? [], {
            dataDir: options.dataDir,
            runtime: meta.runtime,
            warn,
          }),
          opening?.servers ?? [],
          warn,
        );
      },
      toolMiddleware: ({ meta }) => [
        redactionMiddleware(() => this.#openingOf(meta)?.redact ?? []),
      ],
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
        // The product's tools are the primary's; MCP comes in through the realm (`mcpFor`).
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
    peer.handle("run", async (raw, { emit, signal }) => {
      const {
        session,
        text,
        images,
        activity: wantsActivity,
      } = raw as DaemonServiceParams["run"];
      const { managed } = await this.#service().open(session);
      // Nobody waits for the run any more (the primary cancelled the call, or the link is gone and
      // the primary has ended its reply): it stops, rather than going on for no one.
      const stop = (): void => managed.session.runner.abort();
      signal.addEventListener("abort", stop, { once: true });
      try {
        return await this.#run(managed, text, images, wantsActivity, emit);
      } finally {
        signal.removeEventListener("abort", stop);
      }
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
    // A clone streams its progress and stops when the primary cancels the call.
    peer.handle("places", async (raw, { signal, emit }) => {
      return await this.#places.serve(raw as DaemonServiceParams["places"], {
        signal,
        emit: (event) => {
          try {
            emit(event);
          } catch {
            // A dying link loses the progress, not the clone.
          }
        },
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
    peer.handle("runtimeAccount", async (raw) => {
      const { runtime } = raw as DaemonServiceParams["runtimeAccount"];
      const account = await this.#runtimes.catalog.account?.(runtime);
      if (account === undefined)
        throw new Error(`no such runtime here: ${runtime}`);
      return account;
    });
    // The settings page's ACP agents, this machine's own. Agents (and so who still runs on an id)
    // are the primary's: it checks that before it asks for a rename or a delete.
    peer.handle("skillFiles", (raw) =>
      this.#skillFiles.execute(raw as DaemonServiceParams["skillFiles"]),
    );
    peer.handle("acpList", async (raw) => {
      const { settled } = (raw ?? {}) as DaemonServiceParams["acpList"];
      const admin = this.#acpAdmin();
      return {
        agents: settled === true ? await admin.settled() : admin.list(),
      };
    });
    peer.handle("acpSave", (raw) => {
      const { agent, previousId } = raw as DaemonServiceParams["acpSave"];
      return this.#acpAdmin().save(agent, previousId);
    });
    peer.handle("acpDelete", (raw) => {
      const { id } = raw as DaemonServiceParams["acpDelete"];
      this.#acpAdmin().delete(id);
      return {};
    });
    peer.handle("acpTest", async (raw) => {
      const { agent } = raw as DaemonServiceParams["acpTest"];
      return await this.#acpAdmin().test(agent);
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
    await this.#mcp.close();
    await this.#store.close();
  }

  /** One run the primary asked for, with its liveness told back when it wants that. */
  async #run(
    managed: ManagedSession,
    text: string,
    images: DaemonServiceParams["run"]["images"],
    wantsActivity: boolean | undefined,
    emit: (event: unknown) => void,
  ): Promise<RunOutcome> {
    if (wantsActivity !== true)
      return await runAndWait(managed, text, undefined, images);
    const on = kernelOn(managed.session.kernel.ctx);
    const activity = (kind: DaemonRunEvent["kind"]): void => {
      try {
        emit({ kind });
      } catch {
        // The run keeps going if a dying link can no longer carry its liveness signal.
      }
    };
    const offs = [
      on("tool:start", () => activity("tool-start")),
      on("tool:update", () => activity("tool-update")),
      on("tool:end", () => activity("tool-end")),
      on("message:start", () => activity("message")),
      on("message:end", () => activity("message")),
    ];
    try {
      return await runAndWait(managed, text, undefined, images);
    } finally {
      for (const off of offs) off();
    }
  }

  #openingOf(meta: SessionMeta): Opening | undefined {
    if (meta.agentId === undefined || meta.conversationId === undefined)
      return undefined;
    return this.#openings.get(keyOf(meta.conversationId, meta.agentId));
  }

  #skillDirsOf(meta: SessionMeta): string[] {
    return (this.#openingOf(meta)?.plugins ?? []).flatMap(({ plugin }) =>
      plugin.skills.map((skill) => skill.dir),
    );
  }

  /** The plugins an open names, from the copies kept here; one that cannot be read is left out. */
  async #openedPlugins(args: OpenSessionArgs): Promise<Opening["plugins"]> {
    const opened: Opening["plugins"] = [];
    for (const { name, hash, servers } of args.plugins ?? []) {
      try {
        opened.push({
          plugin: await loadPlugin(this.#plugins.dir(hash)),
          hash,
          config: servers,
        });
      } catch (error) {
        this.#warn(
          `[eta-daemon] plugin ${name} is not usable: ${messageOf(error)}`,
        );
      }
    }
    return opened;
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
        // What places answers by, so the primary writes this machine's paths its way.
        home: this.#places.rules.home,
        os: this.#places.os,
        version: this.#options.version,
        protocol: LINK_PROTOCOL,
        platform: daemonPlatform(),
        install: this.#options.install ?? installKind(),
        chunked: true,
        maxMessageBytes: LINK_LIMITS.maxMessageBytes,
      }),
      open: (args) => this.#open(args),
      catalog: ({ models }) => {
        for (const spec of models) this.#catalog.add(spec);
        return {};
      },
      which: ({ commands }) => ({
        found: commands.filter(
          (command) =>
            Bun.which(command, { PATH: process.env.PATH ?? "" }) !== null,
        ),
      }),
      pluginHave: ({ hashes }) => ({
        missing: hashes.filter((hash) => !this.#plugins.has(hash)),
      }),
      pluginPut: ({ hash, files, done }) => {
        this.#plugins.put(hash, files, done);
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

  #acpAdmin(): AcpAdmin {
    if (this.#acp === undefined)
      throw new Error("this daemon runs no ACP agents");
    return this.#acp;
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
    const external = args.runtime !== undefined && args.runtime !== "eta";
    if (args.modelSpec !== undefined) this.#catalog.add(args.modelSpec);
    this.#openings.set(keyOf(args.conversationId, args.agentId), {
      prompt: args.agentPrompt,
      stamp: args.stamp,
      tools: args.tools,
      cards: external ? [] : ((args.personaCards ?? []) as PersonaCard[]),
      plugins: await this.#openedPlugins(args),
      servers: args.mcpServers ?? [],
      redact: args.redactions ?? [],
    });
    const thinking = (id: string): Promise<unknown> =>
      args.thinkingLevel === undefined
        ? Promise.resolve()
        : sessions
            .thinkingLevel(id, args.thinkingLevel as ThinkingLevel, {
              fallback: true,
            })
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
            persona:
              external || args.persona === undefined ? undefined : args.persona,
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
      ...(external || args.persona === undefined
        ? {}
        : { persona: args.persona }),
    });
    await thinking(id);
    return { session: id };
  }
}
