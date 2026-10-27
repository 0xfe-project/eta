import type { CpaClient, CpaConfig } from "@cpajs/cpa/client";
import type { CpaServer } from "@cpajs/cpa/server";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/**
 * CLIProxyAPI (CPA), run as a child process through `@cpajs/cpa`.
 *
 * CPA listens on a random loopback port. Its `/v1` takes one key, made up per start, which never
 * leaves this process (agents get keys of their own, checked in `runtime.ts`); its management
 * API takes another, also made up per start. That one reaches CPA as `MANAGEMENT_PASSWORD`, in
 * its own environment: CPA compares it as is, where a key in its config is a bcrypt hash it
 * checks on every request (about 65 ms of CPU each, and the gateway asks every few seconds).
 * Upstream takes the variable to allow remote management too, which changes nothing here: CPA
 * binds loopback only. The config is written on every start: the
 * settings below, the API keys the previous run kept in it (`api-keys`, changed at runtime
 * through the management API), and the test overrides. CPA cannot outlive the host (cpajs's
 * launcher), and when it exits on its own it is started again on the same port.
 */
import process from "node:process";
import { startServer } from "@cpajs/cpa/server";

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

export class Cpa {
  readonly #options: CpaOptions;
  /** The key CPA's `/v1` takes. */
  readonly accessKey: string;
  #server: CpaServer;
  #client: CpaClient;
  #stopping = false;
  readonly #moved = new Set<() => void>();

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
    importProviders(options.stateDir);
    const accessKey = randomBytes(32).toString("hex");
    return new Cpa(options, accessKey, await launch(options, accessKey));
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

  /** Call `listener` when CPA was started again somewhere else (its port was taken). */
  onMoved(listener: () => void): () => void {
    this.#moved.add(listener);
    return () => this.#moved.delete(listener);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#server.stop();
  }

  #watch(server: CpaServer): void {
    void server.exited.then((exit) => {
      if (this.#stopping || this.#server !== server) return;
      const last = server.recentLogs
        .slice(-20)
        .map(({ line }) => `  ${line}`)
        .join("\n");
      this.#options.warn(
        `[eta] llm: CPA exited (code ${String(exit.code)}, signal ${String(exit.signal)}); starting it again\n${last}`,
      );
      void this.#respawn(server.port);
    });
  }

  async #respawn(port: number): Promise<void> {
    for (let attempt = 0; !this.#stopping; attempt++) {
      await Bun.sleep(Math.min(30_000, 500 * 2 ** attempt));
      if (this.#stopping) return;
      try {
        // The same port first, so the model layer's address stays right; any port after that.
        const server = await launch(
          this.#options,
          this.accessKey,
          attempt === 0 ? port : undefined,
        );
        if (this.#stopping) {
          await server.stop();
          return;
        }
        this.#server = server;
        this.#client = server.client();
        this.#watch(server);
        if (server.port !== port)
          for (const listener of this.#moved) listener();
        return;
      } catch (error) {
        this.#options.warn(
          `[eta] llm: CPA did not start again: ${String(error)}`,
        );
      }
    }
  }
}

async function launch(
  options: CpaOptions,
  accessKey: string,
  port?: number,
): Promise<CpaServer> {
  const { stateDir, extra = {}, warn } = options;
  const { "api-keys": extraKeys, ...rest } = extra;
  const config: CpaConfig = {
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
    "api-keys": { ...keptKeys(stateDir), ...extraKeys },
    ...rest,
  };
  return startServer({
    stateDir,
    config,
    overwriteConfig: true,
    host: "127.0.0.1",
    ...(port === undefined ? {} : { port }),
    management: {
      key: randomBytes(32).toString("hex"),
      viaEnvironment: true,
    },
    suppressWarnings: { managementViaEnvironment: true },
    onWarning: (warning) => warn(`[eta] llm: ${warning.message}`),
    // CPA logs every request at info; what the host's log gets is its warnings and errors
    // (and anything on stderr without a level, such as a panic).
    onLog: ({ stream, line }) => {
      const level = /^\[[^\]]*\] \[[^\]]*\] \[(\w+) *\]/.exec(line)?.[1];
      if (
        level === undefined
          ? stream === "stderr"
          : level !== "info" && level !== "debug"
      )
        process.stderr.write(`[cpa] ${line}\n`);
    },
  });
}

/** The API keys the previous run's config held: the one place they are kept. */
function keptKeys(stateDir: string): ApiKeys {
  const path = join(stateDir, "config.yaml");
  if (!existsSync(path)) return {};
  try {
    const doc = Bun.YAML.parse(readFileSync(path, "utf8")) as {
      "api-keys"?: unknown;
    } | null;
    const keys = doc?.["api-keys"];
    return typeof keys === "object" && keys !== null && !Array.isArray(keys)
      ? (keys as ApiKeys)
      : {};
  } catch {
    return {};
  }
}

/**
 * The Go gateway kept Google AI Studio keys in `providers.json` and rendered them into CPA's
 * config on every start. Move them into the config once, then drop the file.
 */
function importProviders(stateDir: string): void {
  const path = join(stateDir, "providers.json");
  if (!existsSync(path)) return;
  let entries: { api_key?: string; disabled?: boolean }[] = [];
  try {
    entries =
      (
        JSON.parse(readFileSync(path, "utf8")) as {
          gemini?: typeof entries;
        }
      ).gemini ?? [];
  } catch {
    return;
  }
  const kept = keptKeys(stateDir);
  const have = new Set(
    (kept.gemini ?? []).flatMap((group) =>
      group.keys.map((entry) => entry["api-key"]),
    ),
  );
  const keys = entries
    .filter((entry) => entry.api_key !== undefined && !have.has(entry.api_key))
    .map((entry) => ({
      "api-key": entry.api_key!,
      ...(entry.disabled === true ? { "excluded-models": ["*"] } : {}),
    }));
  if (keys.length > 0) {
    const gemini = [...(kept.gemini ?? []), { keys }];
    const doc = { "api-keys": { ...kept, gemini } };
    writeFileSync(join(stateDir, "config.yaml"), Bun.YAML.stringify(doc), {
      mode: 0o600,
    });
  }
  rmSync(path);
}
