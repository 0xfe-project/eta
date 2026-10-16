import type { MountedPlugin } from "@eta/server";
import type { HostStatus } from "./bundled/host";
import type { EtaConfig } from "./config";
import type { Migration } from "./db/migrations";
/**
 * The host: read the config, open the database, build the cordis tree, mount the plugins,
 * listen — and be able to stop in the reverse order.
 *
 * One process, one cordis root. A session gets its own root when it is opened (REFACTOR.md §9,
 * P0.7), because cordis dispatches a tree's events tree-wide: two kernels under one root would
 * hear each other's events.
 */
import { join } from "node:path";
import process from "node:process";
import { PluginManager } from "@eta/server";
import { Context } from "cordis";
import { hostPlugin } from "./bundled/host";
import { readConfig } from "./config";
import { databasePath, openDatabase } from "./db/database";
import {
  applyMigrations,
  loadMigrations,
  schemaVersion,
} from "./db/migrations";
import { DbService } from "./db/service";
import { EventHub } from "./http/events";
import { IdempotencyStore, withIdempotency } from "./http/idempotency";
import { RouteRegistry, RouteService } from "./routes";

export interface HostOptions {
  /** Where sessions, plugins and the database live: one directory. */
  dataDir: string;
  /** The providers config file. Defaults to `<dataDir>/config.json`. */
  configPath?: string;
  /** The port to listen on. Zero means "any free one". */
  port?: number;
  /** The interface to listen on. Defaults to loopback (REFACTOR.md §7.1). */
  hostname?: string;
  /** How often to look for edits in the user's plugin directory. Zero disables watching. */
  watchIntervalMs?: number;
  /** The migrations to apply. Defaults to the ones on disk. */
  migrations?: readonly Migration[];
  warn?: (message: string) => void;
}

export interface Host {
  ctx: Context;
  routes: RouteService;
  db: DbService;
  /** Where modules publish what a client follows; `/events` is this hub's. */
  hub: EventHub;
  port: number;
  config: EtaConfig;
  mounted: () => MountedPlugin[];
  close: () => Promise<void>;
}

export async function assembleHost(options: HostOptions): Promise<Host> {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const configPath = options.configPath ?? join(options.dataDir, "config.json");
  const config = await readConfig(configPath, warn);

  const ctx = new Context();

  // The database first: a module that injects `db` must find a migrated schema, not a promise.
  const dbPath = databasePath(options.dataDir);
  const handle = await openDatabase(dbPath);
  const migrations = options.migrations ?? (await loadMigrations());
  const applied = applyMigrations(handle, migrations);
  if (applied.length > 0) {
    warn(
      `[eta] applied ${applied.length} migration(s) to ${dbPath}: ${applied.join(", ")}`,
    );
  }
  const db = new DbService(ctx, { path: dbPath, handle, applied });

  // Idempotency sits in front of every POST that carries a key: a retry gets the first answer
  // instead of a second effect (P0.5).
  const idempotency = new IdempotencyStore(handle);
  const routes = new RouteService(
    ctx,
    new RouteRegistry((request, run) =>
      withIdempotency(idempotency, request, run),
    ),
  );
  const hub = new EventHub();
  const status: HostStatus = {
    pid: process.pid,
    dataDir: options.dataDir,
    dbPath,
    schema: schemaVersion(handle),
    startedAt: Date.now(),
    mounted: [],
  };

  // The floor's own routes: with no plugins mounted at all, the host still answers, and there is
  // still somewhere for a client to listen.
  routes.register("GET", "/health", () => Response.json({ ok: true }));
  routes.register("GET", "/events", (request) => hub.handle(request));

  // The bundled plugins. Everything else that answers a request is one of these or a user
  // plugin; the floor knows no feature name of its own.
  const fibers = [ctx.plugin(hostPlugin, { status })];

  const manager = new PluginManager({
    modulesDir: join(options.dataDir, "modules"),
    pluginsDir: join(options.dataDir, "plugins"),
    warn,
    ...(options.watchIntervalMs === undefined
      ? {}
      : { watchIntervalMs: options.watchIntervalMs }),
  });
  status.mounted = (await manager.loadAll(ctx)).map((plugin) =>
    plugin.error === undefined
      ? plugin.name
      : `${plugin.name} (${plugin.error})`,
  );
  if (options.watchIntervalMs !== undefined && options.watchIntervalMs > 0)
    manager.watch(ctx);

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
    fetch: (request) => routes.dispatch(request),
  });

  return {
    ctx,
    routes,
    db,
    hub,
    port: server.port ?? 0,
    config,
    mounted: () => manager.mounted(),
    async close() {
      // Reverse order: stop taking requests, take the plugins out (the user's first, then
      // ours — their effects unregister what they registered), take back whatever routes are
      // left, and only then close the file. A route a plugin forgot to clean up goes with
      // the rest, so stopping is a shutdown rather than a leak.
      server.stop();
      manager.stop();
      await manager.dispose();
      for (const fiber of fibers.splice(0)) await fiber.dispose();
      routes.registry.clear();
      handle.close();
    },
  };
}
