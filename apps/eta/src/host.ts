import type { Places } from "@eta/places";
import type { AcpRuntimes } from "@eta/runtime-acp";
import type {
  AssembledServer,
  AssembleOptions,
  ListedRuntimes,
} from "@eta/server";
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
import type { SiteLimits } from "./artifacts/files";
import type { LlmOptions, LlmRuntime } from "./llm/runtime";
import type { SshRunner } from "./machines/install";
import type {
  ManagedTunnel,
  TunnelConfig,
  TunnelSpawn,
} from "./machines/tunnel";
import type {
  ComposioTuning,
  McpTuning,
  Product,
  RepliesOptions,
  RoutinesOptions,
  RssTuning,
  TasksOptions,
} from "./product";
import type { UpgradePluginOptions } from "./upgrade/plugin";
import type { WebOptions } from "./web/service";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { etaCompaction } from "@eta/compaction";
import { createAcpRuntimes } from "@eta/runtime-acp";
import { createOarRuntimes } from "@eta/runtime-oar";
import { assembleServer, composeRuntimes } from "@eta/server";
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
import { openLlm } from "./llm/runtime";
import { buildsIn, defaultBuilds } from "./machines/builds";
import { Tailscale } from "./machines/tailscale";
import {
  normalizeTunnelPublicUrl,
  startCloudflaredTunnel,
} from "./machines/tunnel";
import { clearMigrationInput, stageMigrationInput } from "./model-backfill";
import { createProduct } from "./product";
import { COMPILED } from "./resources";
import { localOrigin } from "./running";

interface TunnelRunnerOverrides {
  binary?: string | undefined;
  startupTimeoutMs?: number | undefined;
  stopGraceMs?: number | undefined;
  spawn?: TunnelSpawn | undefined;
}

export type HostTunnelOption = boolean | (TunnelConfig & TunnelRunnerOverrides);

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
  /** The primary's directories (`@eta/places`); a test hands in one with a home of its own. */
  places?: Places;
  /**
   * MCP for the sessions this host runs (`~/.eta/mcp.json`, the project's `.mcp.json`) is always
   * on; this is a test's tuning (the library's fetch pointed at a fake, and its manager without
   * timers).
   */
  mcp?: McpTuning;
  /** Test tuning for Composio trigger REST/WebSocket endpoints. */
  composio?: ComposioTuning;
  /** Test tuning for built-in RSS / Atom / JSON Feed polling triggers. */
  rss?: RssTuning;
  /** What a published site may hold; the defaults are for real use, a test makes them small. */
  artifactLimits?: Partial<SiteLimits> | undefined;
  /**
   * The address the user's browser reaches the host at (`https://eta.example.com`), when it is not
   * the one the web page was opened at: where an OAuth sign-in (MCP) returns to.
   */
  publicUrl?: string;
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
  /** How long a stopped reply waits for its run; a test shortens it. */
  replies?: RepliesOptions;
  /** Whether this host starts El Capitan. Tests that are not about Captain leave it off. */
  captain?: boolean;
  /**
   * The external agent runtimes (Claude Code, Codex, OpenCode, Pi, Antigravity, Grok Build, Qwen Code)
   * agents may run on: oar's, on this machine, by default. A test hands in scripted ones; `false`
   * runs none.
   */
  runtimes?: ListedRuntimes | false;
  /**
   * The ACP agents agents may run on, each a runtime `acp.<id>`: the ones `acp.json` in the data
   * directory lists, by default (`~/.eta/acp.json` on an installed host). They are offered
   * beside `runtimes`; `false` offers none.
   */
  acp?: AcpRuntimes | false;
  /**
   * Tailscale on this host (discovering machines, letting the user's own nodes in): `true` reads
   * it through the `tailscale` command; a test hands in one with a scripted command. Off by
   * default; `main.ts` turns it on.
   */
  tailscale?: boolean | Tailscale;
  /**
   * The daemon builds this primary carries (`apps/daemon/scripts/build.ts`): `true` looks where
   * they are kept (the checkout's `apps/daemon/out/dist`, or inside a compiled host), a string is
   * a directory of them. Off by default, so a host made for a test leaves daemons at whatever
   * build they are; `main.ts` turns it on.
   */
  daemonBuilds?: boolean | string;
  /**
   * Managed `cloudflared` tunnel for Tailscale-free remote HTTPS access: `true` starts a Quick
   * Tunnel, or pass `{ mode: "quick" | "named", ... }` (with optional test overrides). Enabling
   * a tunnel always forces the token gate on, even when bound to loopback.
   */
  tunnel?: HostTunnelOption | undefined;
  /** How a daemon is put on another computer; the user's `ssh` by default (a test fakes it). */
  ssh?: SshRunner;
  /** What the update button works with, for a test. */
  upgrade?: Partial<UpgradePluginOptions>;
  warn?: (message: string) => void;
}

export interface Host {
  readonly port: number;
  readonly hostname: string;
  readonly dataDir: string;
  readonly webDir: string | undefined;
  /** The token file, when the gate is on. */
  readonly tokenFile: string | undefined;
  /** The active managed tunnel's external HTTPS origin, when running and known. */
  readonly tunnelUrl: string | undefined;
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

type ResolvedTunnelOption = TunnelConfig & TunnelRunnerOverrides;

function resolveTunnelOption(
  tunnel: HostTunnelOption | undefined,
  publicUrl: string | undefined,
): ResolvedTunnelOption | undefined {
  if (tunnel === undefined || tunnel === false) return undefined;
  if (tunnel === true) return { mode: "quick" };
  if (tunnel.mode === "quick") return tunnel;
  const effectivePublicUrl = tunnel.publicUrl ?? publicUrl;
  // Validate early before opening the database or binding the port.
  if (tunnel.token.trim() === "") {
    throw new Error("cloudflared named tunnel requires a non-empty token");
  }
  const normalizedPublicUrl =
    effectivePublicUrl !== undefined && effectivePublicUrl.trim() !== ""
      ? normalizeTunnelPublicUrl(effectivePublicUrl)
      : undefined;
  return {
    ...tunnel,
    publicUrl: normalizedPublicUrl,
  };
}

export async function startHost(options: HostOptions): Promise<Host> {
  const hostname = options.hostname ?? "127.0.0.1";
  const tunnelOption = resolveTunnelOption(options.tunnel, options.publicUrl);
  mkdirSync(options.dataDir, { recursive: true });
  // The access check comes first: a token file that cannot be read should stop the host before
  // it has opened anything. Enabling a tunnel always forces token gating even on loopback.
  const access = createAccess({
    hostname,
    dataDir: options.dataDir,
    tokenFile: options.tokenFile,
    requireToken: tunnelOption !== undefined,
    allowOrigins: options.allowOrigins,
  });
  if (options.publicUrl !== undefined) access.allowOrigin(options.publicUrl);
  if (tunnelOption?.mode === "named" && tunnelOption.publicUrl !== undefined) {
    access.allowOrigin(tunnelOption.publicUrl);
  }

  const db = openDatabase(databasePath(options.dataDir));
  let server: AssembledServer;
  let product: Product;
  let llm: LlmRuntime | undefined;
  let tunnel: ManagedTunnel | undefined;
  let activeTunnelUrl: string | undefined =
    tunnelOption?.mode === "named" ? tunnelOption.publicUrl : undefined;
  let revokeQuickTunnelOrigin: (() => void) | undefined;

  const gatewayModels = new GatewayModels();
  try {
    // A migration may need the providers config (0050 does); it is staged, then gone.
    stageMigrationInput(db, join(options.dataDir, "config.json"));
    try {
      applyMigrations(db, loadMigrations());
    } finally {
      clearMigrationInput(db);
    }
    const warn = options.warn ?? ((message: string) => console.warn(message));
    const acp =
      options.acp === false
        ? undefined
        : (options.acp ??
          createAcpRuntimes({
            configPath: join(options.dataDir, "acp.json"),
            warn,
          }));
    const others =
      options.runtimes === false
        ? undefined
        : (options.runtimes ??
          createOarRuntimes({
            warn,
            ...(COMPILED
              ? {
                  mcpBridge: {
                    command: process.execPath,
                    args: ["mcp-bridge"],
                  },
                }
              : {}),
          }));
    // Each set answers for its own ids; the catalog is one after the other.
    const runtimes =
      others === undefined && acp === undefined
        ? undefined
        : composeRuntimes([
            ...(others === undefined ? [] : [others]),
            ...(acp === undefined ? [] : [acp]),
          ]);
    product = createProduct({
      db,
      dataDir: options.dataDir,
      warn,
      ...(options.routines === undefined ? {} : { routines: options.routines }),
      ...(options.tasks === undefined ? {} : { tasks: options.tasks }),
      ...(options.replies === undefined ? {} : { replies: options.replies }),
      ...(options.captain === undefined ? {} : { captain: options.captain }),
      artifactLimits: options.artifactLimits,
      publicUrl: options.publicUrl,
      tunnelUrl: () => activeTunnelUrl,
      accessToken: access.token,
      ...(options.web === undefined || options.web === false
        ? {}
        : { web: options.web === true ? {} : options.web }),
      hostname,
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.places === undefined ? {} : { places: options.places }),
      ...(runtimes === undefined
        ? {}
        : {
            runtimes: async (fresh) => await runtimes.catalog.list(fresh),
            runtimeAccount: async (runtime) =>
              await runtimes.catalog.account?.(runtime),
          }),
      ...(acp === undefined ? {} : { acp }),
      ...(options.tailscale === undefined || options.tailscale === false
        ? {}
        : {
            tailscale:
              options.tailscale === true ? new Tailscale() : options.tailscale,
          }),
      ...(options.daemonBuilds === undefined || options.daemonBuilds === false
        ? {}
        : {
            daemonBuilds:
              options.daemonBuilds === true
                ? defaultBuilds(options.dataDir)
                : buildsIn(options.daemonBuilds),
          }),
      ...(options.ssh === undefined ? {} : { ssh: options.ssh }),
      ...(options.upgrade === undefined ? {} : { upgrade: options.upgrade }),
      ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
      ...(options.composio === undefined ? {} : { composio: options.composio }),
      ...(options.rss === undefined ? {} : { rss: options.rss }),
    });
    const web = createWebRoutes(options.webDir);
    server = await assembleServer({
      dataDir: options.dataDir,
      configPath: join(options.dataDir, "config.json"),
      port: options.port,
      hostname,
      // The product's pages (artifacts) first; they answer for their own paths, found or not.
      fetch: async (request) =>
        (await product.fetch(request)) ?? (await web(request)),
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
      monthlySummaries: async (schedule) =>
        llm?.gateway.monthlySummaries(schedule, warn) ?? [],
      streamQuotaSummaries: async (schedule, publish) =>
        llm?.gateway.streamQuotaSummaries(schedule, warn, publish),
      // What the product adds to every session it owns: the agent's words in the system prompt,
      // and, from each of its features, tools, tool middleware and an ear for questions.
      agentPromptFor: product.engine.agentPromptFor,
      skillDirsFor: product.skillDirsFor,
      runtimeExtrasFor: product.runtimeExtrasFor,
      mcpFor: product.mcp.host.sessionMcp,
      ...product.sessionHooks,
      memoryEnabledFor: product.memoryEnabledFor,
      baseSystemPromptFor: product.baseSystemPromptFor,
      generated: product.generated,
      // An agent on an external runtime has its sessions' runs taken by it (`@eta/runtime-oar`,
      // `@eta/runtime-acp`).
      ...(runtimes === undefined ? {} : { runtimes }),
      ...(options.models === undefined ? {} : { models: options.models }),
      ...(options.llm !== undefined && options.llm !== false
        ? { overlayModels: gatewayModels.overlay }
        : {}),
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.network === undefined ? {} : { network: options.network }),
      // `web.privateNetwork` in the config, now and whenever it changes: no restart.
      onPrivateNetwork: (privateNetwork) =>
        product.setPrivateNetwork(privateNetwork),
      warn,
    });
    try {
      await product.mount(server);
      // Start the tunnel once the HTTP server is listening and mounted so the bound port (including
      // `--port 0`) is live and ready to receive forwarded traffic.
      if (tunnelOption !== undefined) {
        const targetUrl = localOrigin(hostname, server.server.port);
        let tunnelExited = false;
        tunnel = await startCloudflaredTunnel({
          config:
            tunnelOption.mode === "quick"
              ? { mode: "quick" }
              : {
                  mode: "named",
                  token: tunnelOption.token,
                  publicUrl: tunnelOption.publicUrl,
                },
          targetUrl,
          binary: tunnelOption.binary,
          startupTimeoutMs: tunnelOption.startupTimeoutMs,
          stopGraceMs: tunnelOption.stopGraceMs,
          spawn: tunnelOption.spawn,
          warn,
          onExit: () => {
            tunnelExited = true;
            activeTunnelUrl = undefined;
            revokeQuickTunnelOrigin?.();
            revokeQuickTunnelOrigin = undefined;
          },
        });
        if (!tunnelExited) {
          activeTunnelUrl = tunnel.url;
          if (tunnel.mode === "quick" && tunnel.url !== undefined) {
            revokeQuickTunnelOrigin = access.allowOrigin(tunnel.url);
          }
        }
      }
      // After the server: it has applied the network settings, which the gateway's own
      // requests to the providers then inherit.
      if (options.llm !== undefined && options.llm !== false) {
        llm = await openLlm({
          ...(options.llm === true ? {} : options.llm),
          dataDir: options.dataDir,
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
      await tunnel?.stop();
      await llm?.close();
      await product.close();
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
    get tunnelUrl() {
      return activeTunnelUrl;
    },
    db,
    product,
    server,
    llm,
    // Once: a signal and a caller may both ask, and the second has nothing left to close.
    close() {
      closing ??= (async () => {
        await tunnel?.stop();
        activeTunnelUrl = undefined;
        revokeQuickTunnelOrigin?.();
        revokeQuickTunnelOrigin = undefined;
        await product.close();
        await server.close();
        await llm?.close();
        db.close();
      })();
      return closing;
    },
  };
}
