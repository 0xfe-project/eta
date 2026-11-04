import type { OarRuntimes } from "@eta/runtime-oar";
import type { AssembledServer, AssembleOptions } from "@eta/server";
/**
 * The host: the upstream server floor, plus what a product around it needs.
 *
 * `assembleServer` is the floor (sessions, providers, settings, personas behind one WebSocket).
 * This file puts three things next to it, in one process: the product's SQLite database with its
 * migrations applied, the HTTP side that serves the web, and the access control in front of both.
 * The product (agents, machines, projects, conversations: `product.ts`) is made on that database
 * before the floor, because the floor's per-session hooks are its, and mounted on the floor after.
 */
import type { Database } from "bun:sqlite";
import type { SiteLimits } from "./artifacts/site";
import type { GithubTuning } from "./github/service";
import type { LlmOptions, LlmRuntime } from "./llm/runtime";
import type { SshRunner } from "./machines/install";
import type { Product, RoutinesOptions, TasksOptions } from "./product";
import type { WebOptions } from "./web/service";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { etaCompaction } from "@eta/compaction";
import { createOarRuntimes } from "@eta/runtime-oar";
import { assembleServer } from "@eta/server";
import { createAccess } from "./access";
import {
  applyMigrations,
  databasePath,
  loadMigrations,
  openDatabase,
} from "./db";
import { createWebRoutes } from "./http";
import { GatewayModels } from "./llm/models";
import { llmPlugin } from "./llm/plugin";
import { LLM_ROUTE } from "./llm/route";
import { openLlm } from "./llm/runtime";
import { DaemonBuilds, defaultBuildsDir } from "./machines/builds";
import { Tailscale } from "./machines/tailscale";
import { createProduct } from "./product";

export interface HostOptions {
  /** Everything the host owns: the database, the sessions, the providers config. */
  dataDir: string;
  /** Zero, the default, means any free port. */
  port?: number;
  /** The interface to listen on. Defaults to loopback; anything else turns the token gate on. */
  hostname?: string;
  /** The built web (a directory with `index.html`). Without one the host serves the pipe only. */
  webDir?: string;
  /** Turns the token gate on; created (0600) when missing. */
  tokenFile?: string;
  /** Other origins that may open the socket, for a page served elsewhere (the dev server). */
  allowOrigins?: readonly string[];
  /**
   * The memory sidecar's address. Without one the host has no memory: no `memory` target, no
   * memory tools, and nothing is ever sent to a sidecar.
   */
  memoryUrl?: string;
  /**
   * Whether to load the LLM gateway: subscription accounts (Codex, Grok) and Gemini API keys,
   * served as the `llm` provider, by CLIProxyAPI in a child process. Off by default so a host
   * made for a test does not start one; `main.ts` turns it on. A host whose CPA does not start
   * runs without a gateway and says so. The object form is for tests, which point an upstream
   * at a fake.
   */
  llm?: boolean | LlmOptions;
  /** The model layer, when the caller has its own (a test with scripted answers). */
  models?: AssembleOptions["models"];
  /** Where the agent's home is, for personas. Defaults to the real one. */
  home?: string;
  /** What a published site may hold; the defaults are for real use, a test makes them small. */
  artifactLimits?: Partial<SiteLimits> | undefined;
  /**
   * The address the user's browser reaches the host at (`https://eta.example.com`), when it is not
   * the one the web page was opened at: where an OAuth sign-in (GitHub) returns to.
   */
  publicUrl?: string;
  /**
   * The GitHub chain: `true` loads it, a `GithubTuning` (where GitHub is, for a test with a fake
   * one) loads it pointed at that. Off by default, and off means none of it: no `github` target,
   * no GitHub tools, no callback routes, no login on this machine, nothing asked of GitHub. The
   * web hides every GitHub face as soon as `hello` says the plugin is not there.
   */
  github?: boolean | GithubTuning;
  /**
   * `web_fetch` and `web_search` for every session: `true` loads them, searching with the SearXNG
   * the host runs as a child process (where a prebuilt one exists); the object form names an
   * external SearXNG, or, for a test, a fixture site on loopback. Off by default so a host made
   * for a test has neither tool; `main.ts` turns them on.
   */
  web?: boolean | Omit<WebOptions, "warn">;
  /** Whether to apply the config's network settings to the environment. */
  network?: boolean;
  /** The routines' clock and limits, for a caller that moves time by hand (a test). */
  routines?: RoutinesOptions;
  /** Whether tasks run; a test that is about the board and not the runs turns them off. */
  tasks?: TasksOptions;
  /** Whether this host starts El Capitan. Tests that are not about Captain leave it off. */
  captain?: boolean;
  /**
   * The external agent runtimes (Claude Code, Codex, OpenCode, Pi) agents may run on: oar's, on
   * this machine, by default. A test hands in scripted ones; `false` runs none.
   */
  runtimes?: OarRuntimes | false;
  /**
   * Tailscale on this host (discovering machines, letting the user's own nodes in): `true` reads
   * it through the `tailscale` command; a test hands in one with a scripted command. Off by
   * default; `main.ts` turns it on.
   */
  tailscale?: boolean | Tailscale;
  /**
   * The daemon builds this primary carries (`apps/daemon/scripts/build.ts`): `true` looks where
   * they are kept (the checkout's `apps/daemon/out/dist`, or `daemon/` beside a compiled host), a
   * string is a directory of them. Off by default, so a host made for a test leaves daemons at
   * whatever build they are; `main.ts` turns it on.
   */
  daemonBuilds?: boolean | string;
  /** How a daemon is put on another computer; the user's `ssh` by default (a test fakes it). */
  ssh?: SshRunner;
  warn?: (message: string) => void;
}

export interface Host {
  readonly port: number;
  readonly hostname: string;
  readonly dataDir: string;
  readonly webDir: string | undefined;
  /** The token file, when the gate is on. */
  readonly tokenFile: string | undefined;
  readonly db: Database;
  /** What the product made on the database: its engine and the routines' clock. */
  readonly product: Product;
  /** The upstream server: its sessions, wire service and plugin manager. */
  readonly server: AssembledServer;
  /** The LLM gateway, when it is running. */
  readonly llm: LlmRuntime | undefined;
  /** Stop listening, close the sessions and the database. */
  close: () => Promise<void>;
}

export async function startHost(options: HostOptions): Promise<Host> {
  const hostname = options.hostname ?? "127.0.0.1";
  mkdirSync(options.dataDir, { recursive: true });
  // The access check comes first: a token file that cannot be read should stop the host before
  // it has opened anything.
  const access = createAccess({
    hostname,
    dataDir: options.dataDir,
    tokenFile: options.tokenFile,
    allowOrigins: options.allowOrigins,
  });

  const db = openDatabase(databasePath(options.dataDir));
  let server: AssembledServer;
  let product: Product;
  let llm: LlmRuntime | undefined;
  const gatewayModels = new GatewayModels();
  try {
    applyMigrations(db, loadMigrations());
    const warn = options.warn ?? ((message: string) => console.warn(message));
    const runtimes =
      options.runtimes === false
        ? undefined
        : (options.runtimes ?? createOarRuntimes({ warn }));
    product = createProduct({
      db,
      dataDir: options.dataDir,
      warn,
      ...(options.routines === undefined ? {} : { routines: options.routines }),
      ...(options.tasks === undefined ? {} : { tasks: options.tasks }),
      ...(options.captain === undefined ? {} : { captain: options.captain }),
      artifactLimits: options.artifactLimits,
      memoryUrl: options.memoryUrl,
      gateway: () => llm,
      publicUrl: options.publicUrl,
      github: options.github,
      ...(options.web === undefined || options.web === false
        ? {}
        : { web: options.web === true ? {} : options.web }),
      hostname,
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(runtimes === undefined
        ? {}
        : { runtimes: async (fresh) => await runtimes.catalog.list(fresh) }),
      ...(options.tailscale === undefined || options.tailscale === false
        ? {}
        : {
            tailscale:
              options.tailscale === true ? new Tailscale() : options.tailscale,
          }),
      ...(options.daemonBuilds === undefined || options.daemonBuilds === false
        ? {}
        : {
            daemonBuilds: new DaemonBuilds(
              options.daemonBuilds === true
                ? defaultBuildsDir()
                : options.daemonBuilds,
            ),
          }),
      ...(options.ssh === undefined ? {} : { ssh: options.ssh }),
    });
    const web = createWebRoutes(options.webDir);
    server = await assembleServer({
      dataDir: options.dataDir,
      configPath: join(options.dataDir, "config.json"),
      port: options.port,
      hostname,
      // The product's pages (artifacts) first; they answer for their own paths, found or not.
      fetch: async (request) =>
        (llm !== undefined &&
        new URL(request.url).pathname.startsWith(LLM_ROUTE)
          ? await llm.forward(request)
          : undefined) ??
        (await product.fetch(request)) ??
        (await web(request)),
      authorize: access.authorize,
      endpoints: product.endpoints,
      remoteSessions: product.remote,
      // The one place this host hands sessions a way to bound their own context. Wired here and
      // nowhere else, so chat turns, task runs and sessions on a remote machine (which runs a
      // host of its own) all get it: without it every session runs unbound, growing past the
      // provider's window instead of compacting. The threshold is the harness's arithmetic — the
      // smaller of `window − reserve` and the 64k ceiling (`DEFAULT_MAX_CONTEXT_TOKENS`), which
      // is what the session's kernel config carries by default.
      compaction: etaCompaction(),
      // What the product adds to every session it owns: the agent's words in the system prompt,
      // and, from each of its features, tools, tool middleware and an ear for questions.
      agentPromptFor: product.engine.agentPromptFor,
      skillDirsFor: product.skillDirsFor,
      ...product.sessionHooks,
      memoryEnabledFor: product.memoryEnabledFor,
      baseSystemPromptFor: product.baseSystemPromptFor,
      generated: product.generated,
      // An agent on an external runtime has its sessions' runs taken by it (`@eta/runtime-oar`).
      ...(runtimes === undefined ? {} : { runtimes }),
      ...(options.models === undefined ? {} : { models: options.models }),
      ...(options.llm !== undefined && options.llm !== false
        ? { overlayModels: gatewayModels.overlay }
        : {}),
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.network === undefined ? {} : { network: options.network }),
      warn,
    });
    try {
      await product.mount(server);
      // After the server: it has applied the network settings, which the gateway's own
      // requests to the providers then inherit.
      if (options.llm !== undefined && options.llm !== false) {
        llm = await openLlm({
          ...(options.llm === true ? {} : options.llm),
          dataDir: options.dataDir,
          hostOrigin: localOrigin(hostname, server.server.port),
          models: gatewayModels,
          warn,
        });
        if (llm !== undefined) {
          const { gateway } = llm;
          await new Promise<void>((resolve) => {
            server.mount(
              "llm",
              llmPlugin({ gateway, models: gatewayModels, warn }, resolve),
            );
          });
        }
      }
    } catch (error) {
      await llm?.close();
      await server.close();
      throw error;
    }
  } catch (error) {
    db.close();
    throw error;
  }

  let closing: Promise<void> | undefined;
  return {
    port: server.server.port,
    hostname,
    dataDir: options.dataDir,
    webDir: options.webDir,
    tokenFile: access.tokenFile,
    db,
    product,
    server,
    llm,
    // Once: a signal and a caller may both ask, and the second has nothing left to close.
    close() {
      closing ??= (async () => {
        await product.close();
        await server.close();
        await llm?.close();
        db.close();
      })();
      return closing;
    },
  };
}

/** The host's address as this machine reaches it: a wildcard bind is reached on loopback. */
function localOrigin(hostname: string, port: number | undefined): string {
  const host =
    hostname === "0.0.0.0" || hostname === "::" || hostname === ""
      ? "127.0.0.1"
      : hostname.includes(":")
        ? `[${hostname}]`
        : hostname;
  return `http://${host}:${String(port)}`;
}
