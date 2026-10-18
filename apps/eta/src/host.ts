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
import type { Product, RoutinesOptions } from "./product";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createLocalEnvironment } from "@eta/execution-node";
import { assembleServer } from "@eta/server";
import { createAccess } from "./access";
import {
  applyMigrations,
  databasePath,
  loadMigrations,
  openDatabase,
} from "./db";
import { createWebRoutes } from "./http";
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
  /** The model layer, when the caller has its own (a test with scripted answers). */
  models?: AssembleOptions["models"];
  /** Where the agent's home is, for personas. Defaults to the real one. */
  home?: string;
  /** What a published site may hold; the defaults are for real use, a test makes them small. */
  artifactLimits?: Partial<SiteLimits> | undefined;
  /** Whether to apply the config's network settings to the environment. */
  network?: boolean;
  /** The routines' clock and limits, for a caller that moves time by hand (a test). */
  routines?: RoutinesOptions;
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
  try {
    applyMigrations(db, loadMigrations());
    const warn = options.warn ?? ((message: string) => console.warn(message));
    product = createProduct({
      db,
      dataDir: options.dataDir,
      warn,
      ...(options.routines === undefined ? {} : { routines: options.routines }),
      artifactLimits: options.artifactLimits,
    });
    const web = createWebRoutes(options.webDir);
    server = await assembleServer({
      dataDir: options.dataDir,
      configPath: join(options.dataDir, "config.json"),
      port: options.port,
      hostname,
      // The file and shell tools a session runs: the local adapter, when this runtime can
      // host it. Without one a session still works — it simply has no read/write/edit/bash.
      envFor: (meta) => {
        const env = createLocalEnvironment(meta.cwd);
        return env === undefined ? undefined : { env };
      },
      // The product's pages (artifacts) first; they answer for their own paths, found or not.
      fetch: async (request) =>
        (await product.fetch(request)) ?? (await web(request)),
      authorize: access.authorize,
      // What the product adds to every session it owns: the agent's words in the system prompt,
      // and, from each of its features, tools, tool middleware and an ear for questions.
      baseSystemPromptFor: product.engine.baseSystemPromptFor,
      ...product.sessionHooks,
      ...(options.models === undefined ? {} : { models: options.models }),
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.network === undefined ? {} : { network: options.network }),
      warn,
    });
    try {
      await product.mount(server);
    } catch (error) {
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
    // Once: a signal and a caller may both ask, and the second has nothing left to close.
    close() {
      closing ??= (async () => {
        await server.close();
        db.close();
      })();
      return closing;
    },
  };
}
