/**
 * A bundle's service: a process the host keeps for it, the way it keeps the memory sidecar.
 *
 * The bundle's `plugin.json` says how to start it (`service.command`). The host starts it in the
 * bundle's directory on a free loopback port (`PORT`, `HOST`), with the bundle's config values in
 * its environment and a data directory of its own (`ETA_BUNDLE_DATA`), waits for it to answer, and
 * proxies `/bundles/<name>/service/*` to it for the user. Sessions on this machine reach it as
 * `${ETA_SERVICE_URL}`; a daemon cannot, so a bundle's MCP server that needs it is only on the
 * primary.
 *
 * It runs only while the bundle is configured and what it requires is on the PATH. A change to the
 * bundle's files or values restarts it. One that exits is not restarted by itself: it is shown as
 * failed with the last words of its stderr, and the next change (or `recheck`) starts it again.
 */
import type { BundleServiceState } from "@eta/client-contracts";
import type { Subprocess } from "bun";
import type { BundleEntry, BundleRegistry } from "./registry";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { isConfigured } from "@eta/daemon";

interface Running {
  state: BundleServiceState;
  message: string | null;
  port: number;
  revision: string;
  child: Subprocess | undefined;
}

export interface ServiceOptions {
  registry: BundleRegistry;
  /** Where each service keeps its data: `<dataDir>/bundles/<name>`. */
  dataDir: string;
  /** A required command is on this machine's PATH. */
  has: (command: string) => boolean;
  changed: () => void;
  warn: (message: string) => void;
  /** How long a service has to answer before it is called failed. */
  startTimeoutMs?: number;
}

async function freePort(): Promise<number> {
  const probe = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: () => undefined },
  });
  const { port } = probe;
  probe.stop(true);
  return port;
}

export class BundleServices {
  readonly #options: ServiceOptions;
  readonly #running = new Map<string, Running>();
  /** Why a service that should run does not (a missing command), by bundle. */
  #blocked = new Map<string, string>();
  #closed = false;
  #syncing: Promise<void> = Promise.resolve();

  constructor(options: ServiceOptions) {
    this.#options = options;
  }

  state(
    name: string,
  ): { state: BundleServiceState; message: string | null } | undefined {
    const running = this.#running.get(name);
    if (running !== undefined)
      return { state: running.state, message: running.message };
    const blocked = this.#blocked.get(name);
    if (blocked !== undefined) return { state: "stopped", message: blocked };
    const entry = this.#options.registry.get(name);
    return entry?.bundle?.manifest.service === undefined
      ? undefined
      : { state: "stopped", message: null };
  }

  /** The address the service listens on, once it answers. */
  urlOf(name: string): string | undefined {
    const running = this.#running.get(name);
    return running?.state === "ready"
      ? `http://127.0.0.1:${running.port}`
      : undefined;
  }

  /** Bring the running services in line with the bundles: start, restart or stop. Serialised. */
  sync(): Promise<void> {
    this.#syncing = this.#syncing
      .then(() => this.#sync())
      .catch((error: unknown) => {
        this.#options.warn(`[eta] bundle services: ${String(error)}`);
      });
    return this.#syncing;
  }

  async #sync(): Promise<void> {
    if (this.#closed) return;
    const { registry } = this.#options;
    const wanted = new Map<string, { entry: BundleEntry; revision: string }>();
    this.#blocked = new Map();
    for (const entry of registry.entries()) {
      const service = entry.bundle?.manifest.service;
      if (entry.bundle === undefined || service === undefined) continue;
      const config = registry.configOf(entry);
      if (!isConfigured(entry.bundle.manifest, config)) continue;
      const missing = entry.bundle.manifest.requires.filter(
        (command) => !this.#options.has(command),
      );
      if (missing.length > 0) {
        this.#blocked.set(entry.name, `missing: ${missing.join(", ")}`);
        continue;
      }
      wanted.set(entry.name, {
        entry,
        revision: `${entry.signature}\0${JSON.stringify(config)}`,
      });
    }
    for (const [name, running] of [...this.#running]) {
      const target = wanted.get(name);
      if (target === undefined || target.revision !== running.revision) {
        await this.#stop(name);
      }
    }
    for (const [name, { entry, revision }] of wanted) {
      const running = this.#running.get(name);
      // One that failed stays failed until something changes; one that runs is left alone.
      if (running !== undefined) continue;
      await this.#start(entry, revision);
    }
    this.#options.changed();
  }

  async #start(entry: BundleEntry, revision: string): Promise<void> {
    const bundle = entry.bundle!;
    const spec = bundle.manifest.service!;
    const config = this.#options.registry.configOf(entry);
    const port = await freePort();
    const data = join(this.#options.dataDir, "bundles", entry.name);
    mkdirSync(data, { recursive: true });
    const vars: Record<string, string> = {
      ...config,
      PLUGIN_ROOT: bundle.dir,
      PORT: String(port),
      HOST: "127.0.0.1",
      ETA_BUNDLE_DATA: data,
    };
    const expand = (text: string): string =>
      text.replace(
        /\$\{(\w+)\}/g,
        (match, name: string) => vars[name] ?? match,
      );
    const [program, ...args] = spec.command.map(expand);
    const stderr: string[] = [];
    const running: Running = {
      state: "starting",
      message: null,
      port,
      revision,
      child: undefined,
    };
    this.#running.set(entry.name, running);
    try {
      const child = Bun.spawn([program!, ...args], {
        cwd: bundle.dir,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        env: {
          ...process.env,
          ...config,
          ...Object.fromEntries(
            Object.entries(spec.env).map(([key, value]) => [
              key,
              expand(value),
            ]),
          ),
          PORT: String(port),
          HOST: "127.0.0.1",
          ETA_BUNDLE_DATA: data,
        },
      });
      running.child = child;
      void (async () => {
        const reader = child.stderr.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader
            .read()
            .catch(() => ({ done: true, value: undefined }));
          if (done) break;
          stderr.push(decoder.decode(value));
          if (stderr.length > 20) stderr.shift();
        }
      })();
      void child.exited.then((code) => {
        // Only a service that is still the one we run, and not one we stopped.
        if (
          this.#running.get(entry.name) !== running ||
          running.child !== child
        )
          return;
        if (running.state === "stopped") return;
        running.state = "error";
        running.message =
          stderr.join("").trim().split("\n").at(-1) ?? `it exited with ${code}`;
        this.#options.changed();
      });
      const deadline = Date.now() + (this.#options.startTimeoutMs ?? 15_000);
      while (Date.now() < deadline && running.state === "starting") {
        const answered = await fetch(`http://127.0.0.1:${port}${spec.ready}`, {
          signal: AbortSignal.timeout(1000),
        }).then(
          (response) => response.status < 500,
          () => false,
        );
        if (answered) {
          running.state = "ready";
          return;
        }
        await Bun.sleep(100);
      }
      if (running.state === "starting") {
        running.state = "error";
        running.message = "it did not answer in time";
        child.kill();
      }
    } catch (error) {
      running.state = "error";
      running.message = error instanceof Error ? error.message : String(error);
    }
  }

  async #stop(name: string): Promise<void> {
    const running = this.#running.get(name);
    this.#running.delete(name);
    const child = running?.child;
    if (child === undefined) return;
    running!.state = "stopped";
    child.kill();
    await child.exited.catch(() => undefined);
  }

  /** The service of `name` for a request under `/bundles/<name>/service/`, or nothing. */
  async proxy(
    name: string,
    request: Request,
    rest: string,
  ): Promise<Response | undefined> {
    const running = this.#running.get(name);
    if (running?.state !== "ready") return undefined;
    const url = new URL(request.url);
    const target = `http://127.0.0.1:${running.port}${rest}${url.search}`;
    const headers = new Headers(request.headers);
    // The user's cookie and token are for the host, not for a bundle.
    headers.delete("cookie");
    headers.delete("authorization");
    headers.set("host", `127.0.0.1:${running.port}`);
    try {
      return await fetch(target, {
        method: request.method,
        headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : request.body,
        redirect: "manual",
      });
    } catch {
      return new Response("the bundle's service did not answer", {
        status: 502,
      });
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all(
      [...this.#running.keys()].map((name) => this.#stop(name)),
    );
  }
}
