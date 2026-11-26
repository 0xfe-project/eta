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
export const RUNTIME_IDS = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "antigravity",
  "grok",
  "qwen",
] as const;

export type RuntimeId = (typeof RUNTIME_IDS)[number];

const LABELS: Record<RuntimeId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
  antigravity: "Antigravity",
  grok: "Grok Build",
  qwen: "Qwen Code",
};

/**
 * The runtimes whose model listing answers signed out as well (Grok Build 1.0.89 lists its
 * built-in models without an account): their own sign-in query says whether one can run.
 */
const LISTS_SIGNED_OUT: ReadonlySet<RuntimeId> = new Set(["grok"]);

export function isRuntimeId(value: string): value is RuntimeId {
  return (RUNTIME_IDS as readonly string[]).includes(value);
}

export interface RuntimeModel {
  /** The runtime's own id for it: what `--model` takes. */
  id: string;
  name: string;
  /** The model the runtime runs when it is told none. */
  default: boolean;
  /**
   * The reasoning-effort levels it takes, in the runtime's spelling; empty when the runtime has no
   * effort setting for it (oar leaves `effortLevels` out).
   */
  efforts: string[];
  /** The runtime has one but could not say its levels this time (`effortUnavailableReason`). */
  effortsUnknown?: boolean;
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

/** Who a runtime is signed in as and how much of its plan is used; a part it cannot say is absent. */
export interface RuntimeAccount {
  auth?:
    | { kind: "logged_in"; email?: string; plan?: string; method?: string }
    | { kind: "logged_out"; detail?: string }
    | { kind: "unknown"; detail?: string };
  usage?:
    | {
        kind: "available";
        plan?: string;
        email?: string;
        rateLimited: boolean;
        windows: { label: string; usedRatio: number; resetsAt?: string }[];
      }
    | { kind: "reauth_required"; reason?: string }
    | { kind: "unsupported"; reason?: string }
    | { kind: "error"; detail: string };
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

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

  /** What the user calls a runtime. */
  label(id: RuntimeId): string {
    return LABELS[id];
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

  /**
   * A runtime's sign-in and plan usage, from its own read-only queries (oar's `authStatus` and
   * `accountUsage`); undefined for a runtime that is not one of these. Each part is asked apart, so
   * a usage read that fails still leaves the sign-in said. Never cached: a settings page asks.
   */
  async account(id: string): Promise<RuntimeAccount | undefined> {
    if (!isRuntimeId(id)) return undefined;
    const runtime = this.#registry.require(id);
    if (runtime.authStatus === undefined && runtime.accountUsage === undefined)
      return {};
    const installation = await this.installation(id);
    const options = { timeoutMs: this.#timeoutMs };
    const [auth, usage] = await Promise.all([
      runtime.authStatus === undefined
        ? undefined
        : runtime.authStatus(installation, options).then(
            (status): RuntimeAccount["auth"] =>
              status.kind === "logged_in"
                ? {
                    kind: "logged_in",
                    ...(status.account?.email === undefined
                      ? {}
                      : { email: status.account.email }),
                    ...(status.account?.plan === undefined
                      ? {}
                      : { plan: status.account.plan }),
                    ...(status.account?.method === undefined
                      ? {}
                      : { method: status.account.method }),
                  }
                : {
                    kind: status.kind,
                    ...(status.detail === undefined
                      ? {}
                      : { detail: status.detail }),
                  },
            (error: unknown): RuntimeAccount["auth"] => ({
              kind: "unknown",
              detail: messageOf(error),
            }),
          ),
      runtime.accountUsage === undefined
        ? undefined
        : runtime.accountUsage(installation, options).then(
            (snapshot): RuntimeAccount["usage"] =>
              snapshot.kind === "available"
                ? {
                    kind: "available",
                    ...(snapshot.plan === undefined
                      ? {}
                      : { plan: snapshot.plan }),
                    ...(snapshot.email === undefined
                      ? {}
                      : { email: snapshot.email }),
                    rateLimited: snapshot.rateLimited,
                    windows: snapshot.windows.map((window) => ({
                      label: window.label,
                      usedRatio: window.usedRatio,
                      ...(window.resetsAt === undefined
                        ? {}
                        : { resetsAt: window.resetsAt }),
                    })),
                  }
                : {
                    // oar's `unavailable` is an expired access token: a sign-in to renew, as said.
                    kind:
                      snapshot.kind === "unavailable"
                        ? "reauth_required"
                        : snapshot.kind,
                    ...(snapshot.reason === undefined
                      ? {}
                      : { reason: snapshot.reason }),
                  },
            (error: unknown): RuntimeAccount["usage"] => ({
              kind: "error",
              detail: messageOf(error),
            }),
          ),
    ]);
    return {
      ...(auth === undefined ? {} : { auth }),
      ...(usage === undefined ? {} : { usage }),
    };
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
        // Installed but not usable here (a version oar does not run, say): say why, not "missing".
        const detail =
          snapshot?.kind === "unsupported"
            ? `cannot run here: ${snapshot.reason}`
            : "is not installed";
        return {
          info: { ...base, status: "missing", detail },
          installation: undefined,
          at,
        };
      }
      const version =
        snapshot.via === "executable" ? snapshot.version : undefined;
      const options = { timeoutMs: this.#timeoutMs };
      const [listed, signedOut] = await Promise.all([
        runtime.listModels?.(snapshot, options),
        // Asked apart only where the listing cannot tell; a sign-in it cannot read is no answer.
        LISTS_SIGNED_OUT.has(id) && runtime.authStatus !== undefined
          ? runtime.authStatus(snapshot, options).then(
              (status) => status.kind === "logged_out",
              () => false,
            )
          : false,
      ]);
      const unauthenticated = listed?.kind === "unauthenticated" || signedOut;
      const info: RuntimeInfo = {
        ...base,
        status: unauthenticated ? "unauthenticated" : "available",
        ...(version === undefined ? {} : { version }),
        ...(listed?.kind === "unauthenticated"
          ? { detail: listed.detail ?? "is not signed in" }
          : signedOut
            ? { detail: "is not signed in" }
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
                  ...(model.effortLevels === undefined &&
                  model.effortUnavailableReason !== undefined
                    ? { effortsUnknown: true }
                    : {}),
                }))
            : [],
      };
      return { info, installation: snapshot, at };
    } catch (error) {
      return {
        info: {
          ...base,
          status: "error",
          detail: messageOf(error),
        },
        installation: undefined,
        at,
      };
    }
  }
}
