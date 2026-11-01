/**
 * CLIProxyAPI (CPA), run as a child process through `@cpajs/cpa`.
 *
 * CPA listens on a random loopback port. Its `/v1` takes one key, made up per start, which never
 * leaves this process (agents get keys of their own, checked in `runtime.ts`); its management
 * API takes a key cpajs makes up and keeps behind `server.client()`. The config is written on
 * every launch: the settings below, the API keys the previous run kept in it (`api-keys`,
 * changed at runtime through the management API), and the test overrides. CPA cannot outlive
 * the host (cpajs's launcher).
 *
 * When CPA exits on its own it is started again, on whatever port is free: `client` and
 * `baseUrl` then answer for the new process, and `onRestarted` says so. The wait before a start
 * doubles (to 30 s) while CPA keeps dying within a minute of starting, and is short again once
 * it has stayed up.
 */
import type { CpaClient, CpaConfig } from "@cpajs/cpa/client";
import type { CpaServer } from "@cpajs/cpa/server";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { startServer } from "@cpajs/cpa/server";
import { besideExecutable, COMPILED } from "../resources";

type ApiKeys = NonNullable<CpaConfig["api-keys"]>;

export interface CpaOptions {
  stateDir: string;
  /**
   * Merged over the generated config; `api-keys` provider by provider. How a test points an
   * upstream at a fake server, not a way for users to configure CPA.
   */
  extra?: CpaConfig | undefined;
  warn: (message: string) => void;
}

/** How long CPA must stay up for its next restart to be quick again. */
const STABLE_MS = 60_000;

export class Cpa {
  /** The key CPA's `/v1` takes. */
  readonly accessKey: string;
  readonly #options: CpaOptions;
  readonly #restarted = new Set<() => void>();
  #server: CpaServer;
  #client: CpaClient;
  #startedAt = Date.now();
  #backoff = 0;
  #stopping = false;

  private constructor(
    options: CpaOptions,
    accessKey: string,
    server: CpaServer,
  ) {
    this.#options = options;
    this.accessKey = accessKey;
    this.#server = server;
    this.#client = server.client();
    this.#watch(server);
  }

  static async start(options: CpaOptions): Promise<Cpa> {
    const accessKey = randomBytes(32).toString("hex");
    const legacy = join(options.stateDir, "providers.json");
    const server = await launch(options, accessKey, legacy);
    // The keys are in the config now.
    rmSync(legacy, { force: true });
    return new Cpa(options, accessKey, server);
  }

  /** The management API of the running process. */
  get client(): CpaClient {
    return this.#client;
  }

  /** `http://127.0.0.1:<port>/v1`. */
  get baseUrl(): string {
    return this.#server.baseUrl;
  }

  /** The process's id. */
  get pid(): number {
    return this.#server.pid;
  }

  /** Call `listener` when CPA was started again after it exited on its own. */
  onRestarted(listener: () => void): () => void {
    this.#restarted.add(listener);
    return () => this.#restarted.delete(listener);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#server.stop();
  }

  #watch(server: CpaServer): void {
    server.on("exit", ({ code, signal, recentLogs, reason }) => {
      if (reason !== "unexpected" || this.#stopping) return;
      const last = recentLogs
        .slice(-20)
        .map(({ line }) => `  ${line}`)
        .join("\n");
      this.#options.warn(
        `[eta] llm: CPA exited (code ${String(code)}, signal ${String(signal)}); starting it again\n${last}`,
      );
      this.#backoff =
        Date.now() - this.#startedAt < STABLE_MS ? this.#backoff + 1 : 0;
      void this.#respawn();
    });
  }

  async #respawn(): Promise<void> {
    while (!this.#stopping) {
      await Bun.sleep(Math.min(30_000, 250 * 2 ** this.#backoff));
      if (this.#stopping) return;
      try {
        const server = await launch(this.#options, this.accessKey);
        if (this.#stopping) {
          await server.stop();
          return;
        }
        this.#server = server;
        this.#client = server.client();
        this.#startedAt = Date.now();
        this.#watch(server);
        for (const listener of this.#restarted) listener();
        return;
      } catch (error) {
        this.#backoff++;
        this.#options.warn(
          `[eta] llm: CPA did not start again: ${String(error)}`,
        );
      }
    }
  }
}

function launch(
  { stateDir, extra = {}, warn }: CpaOptions,
  accessKey: string,
  legacy?: string,
): Promise<CpaServer> {
  const { "api-keys": extraKeys, ...rest } = extra;
  return startServer({
    stateDir,
    // A compiled host has no node_modules to find the platform package in: the binary (and
    // `cpa-launcher`, which cpajs looks for next to it) travel beside the executable.
    ...(COMPILED ? { binaryPath: besideExecutable("cli-proxy-api") } : {}),
    host: "127.0.0.1",
    config: ({ existing }) => ({
      access: { "api-keys": [accessKey] },
      management: {
        "disable-control-panel": true,
        "disable-auto-update-panel": true,
      },
      observability: {
        logs: { debug: false, "logging-to-file": false, "request-log": false },
        usage: { "usage-statistics-enabled": false },
      },
      routing: { retry: { "request-retry": 1 } },
      "api-keys": {
        ...withProviders(existing?.["api-keys"] ?? {}, legacy),
        ...extraKeys,
      },
      ...rest,
    }),
    suppressWarnings: { noManagementKey: true },
    onWarning: (warning) => warn(`[eta] llm: ${warning.message}`),
    // CPA logs every request at info; the host's log gets its warnings and errors, and
    // anything on stderr without a level (a panic, say), not its banners on stdout.
    onLog: ({ stream, level, line }) => {
      if (
        level === undefined
          ? stream === "stderr"
          : level !== "info" && level !== "debug"
      )
        process.stderr.write(`[cpa] ${line}\n`);
    },
  });
}

/**
 * The Go gateway kept Google AI Studio keys in `providers.json` and rendered them into CPA's
 * config on every start: add the ones the config lacks, once (the file goes after the start).
 */
function withProviders(keys: ApiKeys, path: string | undefined): ApiKeys {
  if (path === undefined || !existsSync(path)) return keys;
  let entries: { api_key?: string; disabled?: boolean }[];
  try {
    entries =
      (JSON.parse(readFileSync(path, "utf8")) as { gemini?: typeof entries })
        .gemini ?? [];
  } catch {
    return keys;
  }
  const have = new Set(
    (keys.gemini ?? []).flatMap((group) =>
      group.keys.map((entry) => entry["api-key"]),
    ),
  );
  const added = entries
    .filter((entry) => entry.api_key !== undefined && !have.has(entry.api_key))
    .map((entry) => ({
      "api-key": entry.api_key!,
      ...(entry.disabled === true ? { "excluded-models": ["*"] } : {}),
    }));
  return added.length === 0
    ? keys
    : { ...keys, gemini: [...(keys.gemini ?? []), { keys: added }] };
}
