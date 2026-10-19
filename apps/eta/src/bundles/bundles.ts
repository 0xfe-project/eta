import type { OpenedBundle } from "@eta/client-contracts";
import type { McpServerConfig } from "@eta/daemon";
/**
 * Bundles on the host: everything the product needs from them, in one place.
 *
 * It owns the registry, the sealed values, the services and the readiness of machines, and answers
 * the questions the rest of the product has: which skill directories, MCP servers and akhook
 * layers does this agent's session get, what is its stamp, and what is sent to a daemon so that
 * the same agent works there. The product builds one and hands out the pieces.
 */
import type { ConfigInput } from "@eta/plugin-akhook";
import type { SessionMeta } from "@eta/server";
import type { Database } from "bun:sqlite";
import type { MachineHub, MachineLink } from "../machines/hub";
import type { MachineStore } from "../machines/store";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  bundleHookLayer,
  bundleMcpServers,
  bundleSkillDirs,
  mcpSessionTools,
} from "@eta/daemon";
import { loadKey } from "../artifacts/capability";
import { Readiness } from "./plugin";
import { BundleRegistry } from "./registry";
import { BundleRows } from "./rows";
import { BundleServices } from "./service";

/** `bundles/` of the repository, where the built-in bundles are. */
const BUILTIN_DIR = fileURLToPath(
  new URL("../../../../bundles", import.meta.url),
);

export class Bundles {
  readonly registry: BundleRegistry;
  readonly rows: BundleRows;
  readonly services: BundleServices;
  readonly readiness: Readiness;
  /** The MCP tools of the bundles an agent loads, for the host's own sessions. */
  readonly mcp: ReturnType<typeof mcpSessionTools>;
  readonly #agentBundles: (agentId: string | undefined) => readonly string[];
  readonly #warn: (message: string) => void;

  constructor(options: {
    db: Database;
    dataDir: string;
    /** The user's home: `~/.eta/bundles` is under it. */
    home: string;
    machines: MachineStore;
    hub: MachineHub;
    /** The bundles an agent loads, by name. */
    agentBundles: (agentId: string | undefined) => readonly string[];
    /** Say the `bundles` target moved. */
    changed: () => void;
    warn: (message: string) => void;
    builtinDir?: string | undefined;
  }) {
    this.#agentBundles = options.agentBundles;
    this.#warn = options.warn;
    this.rows = new BundleRows(
      options.db,
      loadKey(join(options.dataDir, "secret.key")),
    );
    this.registry = new BundleRegistry({
      builtinDir: options.builtinDir ?? BUILTIN_DIR,
      root: join(options.home, ".eta", "bundles"),
      rows: this.rows,
      changed: () => {
        options.changed();
        void this.services.sync();
        void this.readiness.check();
      },
      warn: options.warn,
    });
    // Read from the environment each time, so a command installed since is found.
    const has = (command: string): boolean =>
      Bun.which(command, { PATH: process.env.PATH ?? "" }) !== null;
    this.services = new BundleServices({
      registry: this.registry,
      dataDir: options.dataDir,
      has,
      changed: options.changed,
      warn: options.warn,
    });
    this.readiness = new Readiness({
      machines: options.machines,
      hub: options.hub,
      registry: this.registry,
      has,
      changed: options.changed,
      warn: options.warn,
    });
    this.mcp = mcpSessionTools((meta) => this.serversFor(meta), options.warn);
    // A machine that connects (or reconnects) is asked again what it has.
    options.hub.onReady(() => void this.readiness.check());
    mkdirSync(join(options.dataDir, "bundles"), { recursive: true });
  }

  /** The bundles an agent's sessions on this machine load. */
  #active(agentId: string | undefined) {
    return this.registry.active(this.#agentBundles(agentId), (name) =>
      this.services.urlOf(name),
    );
  }

  serversFor(meta: SessionMeta): McpServerConfig[] {
    return this.#active(meta.agentId).flatMap((active) =>
      bundleMcpServers(active, { cwd: meta.cwd }, this.#warn),
    );
  }

  skillDirsFor(meta: SessionMeta): string[] {
    return this.#active(meta.agentId).flatMap(bundleSkillDirs);
  }

  /** The bundles' hook rules, as akhook layers, for a session or a run of this agent. */
  layersFor(agentId: string | undefined, cwd: string): ConfigInput[] {
    return this.#active(agentId).flatMap((active) => {
      const layer = bundleHookLayer(active, { cwd });
      return layer === undefined ? [] : [layer];
    });
  }

  /** What an agent's sessions were opened with, as far as bundles go. */
  stampOf(bundles: readonly string[]): string {
    return this.registry.stamp(bundles);
  }

  /**
   * Make the bundles an agent loads ready on a daemon's machine: send the files it does not have
   * yet, and say what its processes get. A bundle that cannot be sent is left out and reported.
   */
  async openOn(
    link: MachineLink,
    bundles: readonly string[],
  ): Promise<OpenedBundle[]> {
    const wanted = this.registry.active(bundles).flatMap((active) => {
      try {
        const { hash, files } = this.registry.snapshot(
          active.bundle.manifest.name,
        );
        return [{ active, hash, files }];
      } catch (error) {
        this.#warn(
          `[eta] bundle ${active.bundle.manifest.name} cannot be sent: ${String(error)}`,
        );
        return [];
      }
    });
    if (wanted.length === 0) return [];
    const { missing } = await link.machine("bundleHave", {
      hashes: [...new Set(wanted.map((item) => item.hash))],
    });
    for (const hash of missing) {
      const item = wanted.find((candidate) => candidate.hash === hash)!;
      await link.machine("bundlePut", { hash, files: item.files });
    }
    return wanted.map(({ active, hash }) => ({
      name: active.bundle.manifest.name,
      hash,
      config: { ...active.config },
      configured: active.configured,
    }));
  }

  /** A request under `/bundles/<name>/service/`, for the bundle's service. */
  async route(request: Request): Promise<Response | undefined> {
    const match = /^\/bundles\/([a-z0-9-]+)\/service(\/.*)?$/.exec(
      new URL(request.url).pathname,
    );
    if (match === null) return undefined;
    // A page of another origin must not be able to drive a bundle's service with the user's
    // cookie: a write that names another origin is refused.
    const origin = request.headers.get("origin");
    if (
      origin !== null &&
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      new URL(origin).host !== new URL(request.url).host
    )
      return new Response("cross-origin write refused", { status: 403 });
    return (
      (await this.services.proxy(match[1]!, request, match[2] ?? "/")) ??
      new Response("no such service", { status: 404 })
    );
  }

  /** Start what runs by itself: watching, restoring git sources, services, readiness. */
  start(): void {
    this.registry.watch();
    void this.registry.restore().finally(() => {
      void this.services.sync();
      void this.readiness.check();
    });
  }

  async close(): Promise<void> {
    this.registry.close();
    await this.services.close();
  }
}
