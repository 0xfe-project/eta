/**
 * Which runtimes this machine has, which models each can run, and what a session on each would
 * take.
 *
 * Asking costs something (a binary on PATH, sometimes a process that answers its model list), so
 * the answer is kept and asked again only when it is old. `peek` is the synchronous read a model
 * lookup needs; `list` is the fresh-enough read a settings screen needs.
 *
 * A runtime's adapter is loaded the first time it is asked about (`runtime`), one runtime at a
 * time: oar's root entry would load every runtime it has at once.
 */
import type { RuntimeRegistry } from "@botiverse/oar/browser";
import type {
  AvailableInstallation,
  Runtime,
  SessionCapabilityDeclaration,
} from "@botiverse/oar/capabilities";
import type { AgentRuntimeCapabilities } from "@eta/client-contracts";
import { installedSessionCapabilities } from "@botiverse/oar/capabilities";

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

/**
 * Each runtime's adapter, from its own entry: loading one does not load the others. The
 * specifiers are literal so a compiled host carries them.
 */
const LOADERS: Record<RuntimeId, () => Promise<Runtime>> = {
  claude: async () =>
    (await import("@botiverse/oar/runtimes/claude")).claudeRuntime,
  codex: async () =>
    (await import("@botiverse/oar/runtimes/codex")).codexRuntime,
  opencode: async () =>
    (await import("@botiverse/oar/runtimes/opencode")).opencodeRuntime,
  pi: async () => (await import("@botiverse/oar/runtimes/pi")).piRuntime,
};

/**
 * What a session on this installation would take, as a client is told it: oar's declaration in
 * eta's words. A part oar leaves out is left out here too: unknown, not "no".
 */
export function capabilitiesOf(
  declared: SessionCapabilityDeclaration,
): AgentRuntimeCapabilities {
  const refused = declared.refusedSessionOptions;
  const compact = declared.manualCompaction?.kind;
  return {
    ...(declared.steer === undefined ? {} : { steer: declared.steer }),
    ...(declared.images === undefined ? {} : { images: declared.images }),
    ...(refused === undefined ? {} : { refused: { ...refused } }),
    ...(compact === undefined ? {} : { compact: compact === "supported" }),
    ...(declared.compactionEvents === undefined
      ? {}
      : {
          compactionEvents: {
            started: declared.compactionEvents.started,
            ended: declared.compactionEvents.ended,
          },
        }),
  };
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
  /** What a session on this installation would take; absent when there is no installation. */
  capabilities?: AgentRuntimeCapabilities;
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
  /** oar's answer for that installation, before any session is open. */
  declared: SessionCapabilityDeclaration | undefined;
  at: number;
}

export interface RuntimeCatalogOptions {
  /** The runtimes to reach (a test hands in scripted ones); each from its own entry without one. */
  registry?: RuntimeRegistry;
  /** How long an answer is good for. Default five minutes. */
  ttlMs?: number;
  /** How long one runtime may take to list its models. Default thirty seconds. */
  timeoutMs?: number;
}

export class RuntimeCatalog {
  readonly #registry: RuntimeRegistry | undefined;
  readonly #loaded = new Map<RuntimeId, Promise<Runtime>>();
  readonly #ttlMs: number;
  readonly #timeoutMs: number;
  readonly #entries = new Map<RuntimeId, Entry>();
  readonly #inflight = new Map<RuntimeId, Promise<Entry>>();

  constructor(options: RuntimeCatalogOptions = {}) {
    this.#registry = options.registry;
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** A runtime's adapter, loaded the first time it is wanted. */
  async runtime(id: RuntimeId): Promise<Runtime> {
    if (this.#registry !== undefined) return this.#registry.require(id);
    let loading = this.#loaded.get(id);
    if (loading === undefined) {
      loading = LOADERS[id]();
      // A load that failed is tried again next time rather than kept.
      loading.catch(() => this.#loaded.delete(id));
      this.#loaded.set(id, loading);
    }
    return await loading;
  }

  /** What the user calls a runtime. */
  label(id: RuntimeId): string {
    return LABELS[id];
  }

  /** What is known about a runtime now, without asking; undefined before the first answer. */
  peek(id: RuntimeId): RuntimeInfo | undefined {
    return this.#entries.get(id)?.info;
  }

  /**
   * oar's answer, before any session is open, for the installation known now; undefined before
   * the first answer or without an installation. An open session's own answer comes first.
   */
  peekCapabilities(id: RuntimeId): SessionCapabilityDeclaration | undefined {
    return this.#entries.get(id)?.declared;
  }

  /** One runtime, asked where the answer is old: what a session on it needs, and no other. */
  async info(id: RuntimeId, fresh = false): Promise<RuntimeInfo> {
    return (await this.#entry(id, fresh)).info;
  }

  /**
   * Every runtime, or only the ones `only` names, asked again where the answer is old (`fresh`
   * asks again regardless). A runtime not asked about is not loaded.
   */
  async list(fresh = false, only?: readonly string[]): Promise<RuntimeInfo[]> {
    return await Promise.all(
      RUNTIME_IDS.filter((id) => only === undefined || only.includes(id)).map(
        async (id) => (await this.#entry(id, fresh)).info,
      ),
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
    const runtime = await this.runtime(id);
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
      const runtime = await this.runtime(id);
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
          declared: undefined,
          at,
        };
      }
      const version =
        snapshot.via === "executable" ? snapshot.version : undefined;
      const listed = await runtime.listModels?.(snapshot, {
        timeoutMs: this.#timeoutMs,
      });
      const declared = installedSessionCapabilities(runtime, snapshot);
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
        capabilities: capabilitiesOf(declared),
      };
      return { info, installation: snapshot, declared, at };
    } catch (error) {
      return {
        info: {
          ...base,
          status: "error",
          detail: messageOf(error),
        },
        installation: undefined,
        declared: undefined,
        at,
      };
    }
  }
}
