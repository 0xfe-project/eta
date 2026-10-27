/**
 * CLIProxyAPI (CPA), run as a child process through `@cpajs/cpa`.
 *
 * CPA listens on a random loopback port. Its `/v1` takes one key, made up per start, which never
 * leaves this process (agents get keys of their own, checked in `runtime.ts`); its management
 * API takes a key cpajs makes up and keeps behind `server.client()`. The config is written on
 * every launch: the settings below, the API keys the previous run kept in it (`api-keys`,
 * changed at runtime through the management API), and the test overrides. CPA cannot outlive
 * the host (cpajs's launcher), and when it exits on its own cpajs starts it again on the same
 * port, with the same handle and client.
 */
import type { CpaClient, CpaConfig } from "@cpajs/cpa/client";
import type { CpaServer } from "@cpajs/cpa/server";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
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
  /** The key CPA's `/v1` takes. */
  readonly accessKey: string;
  /** The management API; it follows CPA across restarts. */
  readonly client: CpaClient;
  readonly #server: CpaServer;

  private constructor(
    accessKey: string,
    server: CpaServer,
    warn: (message: string) => void,
  ) {
    this.accessKey = accessKey;
    this.#server = server;
    this.client = server.client();
    server.on("exit", ({ code, signal, recentLogs, willRestart, reason }) => {
      if (reason !== "unexpected") return;
      const last = recentLogs
        .slice(-20)
        .map(({ line }) => `  ${line}`)
        .join("\n");
      warn(
        `[eta] llm: CPA exited (code ${String(code)}, signal ${String(signal)})${
          willRestart ? "; starting it again" : ""
        }\n${last}`,
      );
    });
    server.on("restart-failed", ({ error, willRetry }) =>
      warn(
        `[eta] llm: CPA did not start again${willRetry ? "" : "; giving up"}: ${String(error)}`,
      ),
    );
  }

  static async start(options: CpaOptions): Promise<Cpa> {
    const { stateDir, extra = {}, warn } = options;
    const accessKey = randomBytes(32).toString("hex");
    const { "api-keys": extraKeys, ...rest } = extra;
    const legacy = join(stateDir, "providers.json");
    const server = await startServer({
      stateDir,
      host: "127.0.0.1",
      config: ({ existing, reason }) => ({
        access: { "api-keys": [accessKey] },
        management: {
          "disable-control-panel": true,
          "disable-auto-update-panel": true,
        },
        observability: {
          logs: {
            debug: false,
            "logging-to-file": false,
            "request-log": false,
          },
          usage: { "usage-statistics-enabled": false },
        },
        routing: { retry: { "request-retry": 1 } },
        "api-keys": {
          ...withProviders(
            existing?.["api-keys"] ?? {},
            reason === "start" ? legacy : undefined,
          ),
          ...extraKeys,
        },
        ...rest,
      }),
      // The keys are in the config now.
      hooks: {
        afterStart: ({ reason }) => {
          if (reason === "start") rmSync(legacy, { force: true });
        },
      },
      // On the same port, unless something took it meanwhile (see `onMoved`).
      restart: {
        onUnexpectedExit: true,
        backoffMs: [500, 1000, 2000, 4000, 8000, 16_000, 30_000],
        allowNewPort: true,
      },
      suppressWarnings: { noManagementKey: true },
      onWarning: (warning) => warn(`[eta] llm: ${warning.message}`),
      // CPA logs every request at info; the host's log gets its warnings and errors, and
      // anything on stderr without a level (a panic, say), not its banners on stdout.
      logs: { minLevel: "warn", unleveled: "stderr" },
      onLog: ({ line }) => process.stderr.write(`[cpa] ${line}\n`),
    });
    return new Cpa(accessKey, server, warn);
  }

  /** `http://127.0.0.1:<port>/v1`. */
  get baseUrl(): string {
    return this.#server.baseUrl;
  }

  /** Call `listener` when CPA was started again on another port (its own was taken). */
  onMoved(listener: () => void): () => void {
    return this.#server.on("restarted", ({ originChanged }) => {
      if (originChanged) listener();
    });
  }

  /** The process's id. */
  get pid(): number {
    return this.#server.pid;
  }

  async stop(): Promise<void> {
    await this.#server.stop();
  }
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
