/**
 * Which runtimes this machine has, and which models each can run.
 *
 * Asking costs something (a binary on PATH, sometimes a process that answers its model list), so
 * the answer is kept and asked again only when it is old. `peek` is the synchronous read a model
 * lookup needs; `list` is the fresh-enough read a settings screen needs.
 */
import type {
  AvailableInstallation,
  Runtime,
  RuntimeRegistry,
} from "@botiverse/oar";

/** The runtimes eta offers, in the order a picker shows them. */
export const RUNTIME_IDS = ["claude", "codex", "opencode", "pi"] as const;

export type RuntimeId = (typeof RUNTIME_IDS)[number];

const LABELS: Record<RuntimeId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
};

export function isRuntimeId(value: string): value is RuntimeId {
  return (RUNTIME_IDS as readonly string[]).includes(value);
}

export interface RuntimeModel {
  /** The runtime's own id for it: what `--model` takes. */
  id: string;
  name: string;
  /** The model the runtime runs when it is told none. */
  default: boolean;
  /** The reasoning-effort levels it takes, in the runtime's spelling; empty when it names none. */
  efforts: string[];
}

export interface RuntimeInfo {
  id: RuntimeId;
  label: string;
  /**
   * `available`: installed and signed in, with its models. `unauthenticated`: installed, not
   * signed in. `missing`: not on this machine. `error`: asking failed (`detail` says how).
   */
  status: "available" | "unauthenticated" | "missing" | "error";
  version?: string;
  detail?: string;
  models: RuntimeModel[];
}

interface Entry {
  info: RuntimeInfo;
  installation: AvailableInstallation | undefined;
  at: number;
}

export interface RuntimeCatalogOptions {
  registry: RuntimeRegistry;
  /** How long an answer is good for. Default five minutes. */
  ttlMs?: number;
  /** How long one runtime may take to list its models. Default thirty seconds. */
  timeoutMs?: number;
}

export class RuntimeCatalog {
  readonly #registry: RuntimeRegistry;
  readonly #ttlMs: number;
  readonly #timeoutMs: number;
  readonly #entries = new Map<RuntimeId, Entry>();
  readonly #inflight = new Map<RuntimeId, Promise<Entry>>();

  constructor(options: RuntimeCatalogOptions) {
    this.#registry = options.registry;
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  runtime(id: RuntimeId): Runtime {
    return this.#registry.require(id);
  }

  /** What is known about a runtime now, without asking; undefined before the first answer. */
  peek(id: RuntimeId): RuntimeInfo | undefined {
    return this.#entries.get(id)?.info;
  }

  /** Every runtime, asked again where the answer is old (`fresh` asks again regardless). */
  async list(fresh = false): Promise<RuntimeInfo[]> {
    return await Promise.all(
      RUNTIME_IDS.map(async (id) => (await this.#entry(id, fresh)).info),
    );
  }

  /** The installation a session opens on; throws with the reason when there is none. */
  async installation(id: RuntimeId): Promise<AvailableInstallation> {
    let entry = await this.#entry(id, false);
    // A runtime installed since the last answer should not wait out the cache.
    if (entry.installation === undefined) entry = await this.#entry(id, true);
    if (entry.installation === undefined)
      throw new Error(
        `runtime_unavailable: ${entry.info.label} ${entry.info.detail ?? "is not installed"}`,
      );
    return entry.installation;
  }

  async #entry(id: RuntimeId, fresh: boolean): Promise<Entry> {
    const known = this.#entries.get(id);
    if (!fresh && known !== undefined && Date.now() - known.at < this.#ttlMs)
      return known;
    const running = this.#inflight.get(id);
    if (running !== undefined) return await running;
    const asking = this.#ask(id).finally(() => this.#inflight.delete(id));
    this.#inflight.set(id, asking);
    const entry = await asking;
    this.#entries.set(id, entry);
    return entry;
  }

  async #ask(id: RuntimeId): Promise<Entry> {
    const at = Date.now();
    const base = { id, label: LABELS[id], models: [] as RuntimeModel[] };
    try {
      const runtime = this.#registry.require(id);
      const snapshot = await runtime.installation?.();
      if (snapshot === undefined || snapshot.kind !== "available") {
        return {
          info: { ...base, status: "missing", detail: "is not installed" },
          installation: undefined,
          at,
        };
      }
      const version =
        snapshot.via === "executable" ? snapshot.version : undefined;
      const listed = await runtime.listModels?.(snapshot, {
        timeoutMs: this.#timeoutMs,
      });
      const info: RuntimeInfo = {
        ...base,
        status:
          listed?.kind === "unauthenticated" ? "unauthenticated" : "available",
        ...(version === undefined ? {} : { version }),
        ...(listed?.kind === "unauthenticated"
          ? { detail: listed.detail ?? "is not signed in" }
          : listed?.kind === "unsupported"
            ? { detail: listed.reason }
            : {}),
        models:
          listed?.kind === "ok"
            ? listed.models
                .filter((model) => model.disabled === undefined)
                .map((model) => ({
                  id: model.id,
                  name: model.displayName ?? model.id,
                  default: model.default === true,
                  efforts: [...(model.effortLevels ?? [])],
                }))
            : [],
      };
      return { info, installation: snapshot, at };
    } catch (error) {
      return {
        info: {
          ...base,
          status: "error",
          detail: error instanceof Error ? error.message : String(error),
        },
        installation: undefined,
        at,
      };
    }
  }
}
