import type { ProviderCatalogEntry } from "../providers/catalog";
/**
 * The management surface's derivations (REFACTOR.md §9, P1.4).
 *
 * A settings page asks three questions — which kinds of account can I have, which ones do I have
 * and are they working, and which models can I use — and the answers are all *derived* here rather
 * than stored. There is no state to keep: a connection's health is the last thing that happened to
 * it plus whether its credential is present, and a model's is its provider's.
 *
 * The state names are the product's (`active`, `needs_login`, `rate_limited`, `degraded`, `error`,
 * `unavailable`), and the rules that produce them are the point of this file:
 *
 *   a provider that could not be built      → `error`          (nothing will work until it is fixed)
 *   a credential that is not there          → `needs_login`    (the user has to act)
 *   the last call failed on a rate limit    → `rate_limited`   (waiting fixes it)
 *   the last call failed for another reason → `degraded`       (may clear by itself)
 *   otherwise                               → `active`
 *
 * "The last call" is read from the usage table, which records every generation's outcome and, when
 * it failed, the provider's own words — so a 429 is told apart from a bad key without guessing.
 */
import type { EtaProviderConfig } from "../providers/config-types";
import type { ProviderBuildFailure } from "../providers/runtime";
import type { UsageSubject, UsageTotals } from "../usage/store";
import {
  BUILTIN_PROVIDER_PRESETS,
  providerPreset,
} from "../providers/config-types";

export interface AdminConnector {
  id: string;
  display_name: string;
  /** How this kind is authorised: an API key, or a device-code login. */
  flow: "api_key" | "device_code";
  hint?: string | undefined;
}

export interface AdminReason {
  code: string;
  message: string;
}

export interface AdminConnection {
  id: string;
  connector: string;
  label: string;
  plan?: string | undefined;
  state:
    | "active"
    | "disabled"
    | "needs_login"
    | "rate_limited"
    | "error"
    | "degraded";
  error?: AdminReason | undefined;
  created_at: string;
  /** When this host last looked at it: the moment the answer was derived. */
  checked_at?: string | undefined;
  check_error?: AdminReason | undefined;
}

export interface AdminModel {
  id: string;
  connector: string;
  display_name: string;
  context_window?: number | undefined;
  status: "available" | "degraded" | "unavailable";
  /** Whether chats may use it: anything but `unavailable`. */
  available: boolean;
  reason?: AdminReason | undefined;
}

export interface AdminUsage {
  id: string;
  plan?: string | undefined;
  /** What the provider itself reports it has left. Empty: this host does not poll quotas. */
  windows: {
    kind: string;
    used: number;
    resets_at?: string | undefined;
    duration_seconds?: number | undefined;
  }[];
  error?: string | undefined;
}

export interface AdminAgentUsage {
  principal: string;
  windows: Record<string, AdminCounts>;
  models: (AdminCounts & { name: string })[];
  accounts: (AdminCounts & { name: string })[];
}

export interface AdminCounts {
  requests: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
}

export interface AdminInput {
  providers: readonly EtaProviderConfig[];
  /** The checked-in catalog: which kinds exist, how they authenticate, what they publish. */
  catalog: ReadonlyMap<string, ProviderCatalogEntry>;
  /** Providers that could not be built, with the reason. */
  failures: readonly ProviderBuildFailure[];
  /** The newest hour each provider was used, newest first. */
  recent: readonly {
    provider: string;
    model: string;
    failed: boolean;
    error?: string | undefined;
  }[];
  /** Provider ids a device-code login has credentials for. */
  signedIn: readonly string[];
  /** When the config was last written: when these connections were last changed. */
  createdAt: string;
  now?: Date | undefined;
}

/** Whether a provider's own words say it is asking us to slow down. */
export function isRateLimit(message: string | undefined): boolean {
  if (message === undefined) return false;
  return /429|rate.?limit|too many requests|quota exceeded/i.test(message);
}

/** Whether the provider is telling us the credential is the problem. */
export function isAuthFailure(message: string | undefined): boolean {
  if (message === undefined) return false;
  return /401|403|unauthorized|forbidden|invalid.?api.?key|authentication/i.test(
    message,
  );
}

/** The kinds an account can be of. */
export function connectorsOf(
  catalog: ReadonlyMap<string, ProviderCatalogEntry>,
): AdminConnector[] {
  return [...catalog.values()]
    .map((entry) => {
      const preset =
        BUILTIN_PROVIDER_PRESETS[
          entry.id as keyof typeof BUILTIN_PROVIDER_PRESETS
        ];
      return {
        id: entry.id,
        display_name: preset?.name ?? entry.id,
        flow:
          entry.auth.adapter === "codex-oauth"
            ? ("device_code" as const)
            : ("api_key" as const),
        ...(entry.auth.missingError === undefined
          ? {}
          : { hint: entry.auth.missingError }),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** How one provider's health reads right now. */
function stateOf(
  provider: EtaProviderConfig,
  input: AdminInput,
): {
  state: AdminConnection["state"];
  error?: AdminReason;
  needsLogin: boolean;
} {
  const failure = input.failures.find((entry) => entry.id === provider.id);
  if (failure !== undefined) {
    return {
      state: "error",
      error: { code: "provider_build_failed", message: failure.error },
      needsLogin: false,
    };
  }
  const kind = provider.kind ?? "openai-compatible";
  const entry = input.catalog.get(kind);
  const oauth = entry?.auth.adapter === "codex-oauth";
  // A device-code kind is signed in when a credential exists for it; a key kind when the config
  // carries the key. Either way the user is the only one who can fix it, which is what
  // `needs_login` says.
  const needsLogin = oauth
    ? !input.signedIn.includes(provider.id)
    : entry?.auth.required !== false && (provider.apiKey ?? "").length === 0;
  if (needsLogin) return { state: "needs_login", needsLogin: true };

  const last = input.recent.find((row) => row.provider === provider.id);
  if (last?.failed === true) {
    if (isRateLimit(last.error)) {
      return {
        state: "rate_limited",
        error: {
          code: "rate_limited",
          message: last.error ?? "the provider is rate limiting",
        },
        needsLogin: false,
      };
    }
    return {
      state: "degraded",
      error: {
        code: "provider_error",
        message: last.error ?? "the last call failed",
      },
      needsLogin: false,
    };
  }
  return { state: "active", needsLogin: false };
}

export function connectionsOf(input: AdminInput): AdminConnection[] {
  const checked = (input.now ?? new Date()).toISOString();
  return input.providers.map((provider) => {
    const derived = stateOf(provider, input);
    const label =
      provider.name ??
      providerPreset(provider.kind ?? "openai-compatible")?.name ??
      provider.id;
    return {
      id: provider.id,
      connector: provider.kind ?? "openai-compatible",
      label,
      state: derived.state,
      // What this host saw, not what a provider said: the field exists so a page can say when the
      // answer is from.
      created_at: provider.lastRefreshedAt ?? input.createdAt,
      checked_at: checked,
      ...(derived.error === undefined ? {} : { error: derived.error }),
    };
  });
}

export function modelsOf(input: AdminInput): AdminModel[] {
  const models: AdminModel[] = [];
  for (const provider of input.providers) {
    const derived = stateOf(provider, input);
    const kind = provider.kind ?? "openai-compatible";
    const entry = input.catalog.get(kind);
    for (const model of provider.models) {
      const known = entry?.models.get(model.id);
      const capabilities = model as {
        name?: string | undefined;
        contextWindow?: number | undefined;
      };
      const contextWindow = capabilities.contextWindow ?? known?.contextWindow;
      // `unavailable` is the one status a chat may not use: a provider that is not built, or one
      // whose credential is missing, will not answer however long you wait.
      const status: AdminModel["status"] =
        derived.state === "error" || derived.state === "needs_login"
          ? "unavailable"
          : derived.state === "degraded" || derived.state === "rate_limited"
            ? "degraded"
            : "available";
      models.push({
        // The id an agent names, so what a page shows is what a chat runs on.
        id: `${provider.id}:${model.id}`,
        connector: kind,
        display_name: capabilities.name ?? known?.name ?? model.id,
        ...(contextWindow === undefined
          ? {}
          : { context_window: contextWindow }),
        status,
        available: status !== "unavailable",
        ...(status === "available"
          ? {}
          : {
              reason: {
                code: derived.error?.code ?? "needs_login",
                message:
                  derived.error?.message ??
                  "this account has no credential; sign in before using it",
              },
            }),
      });
    }
  }
  return models;
}

/**
 * Provider-reported subscription limits.
 *
 * Empty, and that is the honest answer: this host counts what it spent (P1.3, `/usage/agents`) and
 * does not poll each provider for the quota it has left. The route exists because the page asks for
 * it, and an empty list renders as "nothing to show" rather than an error.
 */
export function usageOf(_input: AdminInput): AdminUsage[] {
  return [];
}

const countsOf = (totals: UsageTotals): AdminCounts => ({
  requests: totals.requests,
  failed: totals.failed,
  input_tokens: totals.input,
  output_tokens: totals.output,
  cached_tokens: totals.cacheRead,
  reasoning_tokens: totals.reasoning,
  total_tokens: totals.total,
});

/** What one subject spent, in the shape a page reads. */
export function agentUsageOf(
  subjects: readonly UsageSubject[],
): AdminAgentUsage[] {
  return subjects.map((entry) => {
    const windows: Record<string, AdminCounts> = {};
    for (const window of entry.windows) {
      // The keys the page reads: five hours, a day, a week.
      const key = window.hours <= 5 ? "5h" : window.hours <= 24 ? "24h" : "7d";
      windows[key] = countsOf(window);
    }
    const models = entry.models.map((model) => ({
      name: `${model.provider}:${model.model}`,
      ...countsOf(model),
    }));
    // Per-provider totals as the account view: which provision the tokens went to, which is the one
    // thing this host can say about an "account" without asking the provider for one.
    const accounts = new Map<string, UsageTotals>();
    for (const model of entry.models) {
      const held = accounts.get(model.provider);
      accounts.set(
        model.provider,
        held === undefined
          ? model
          : {
              requests: held.requests + model.requests,
              failed: held.failed + model.failed,
              input: held.input + model.input,
              output: held.output + model.output,
              cacheRead: held.cacheRead + model.cacheRead,
              cacheWrite: held.cacheWrite + model.cacheWrite,
              reasoning: held.reasoning + model.reasoning,
              total: held.total + model.total,
            },
      );
    }
    return {
      principal: entry.subject,
      windows,
      models,
      accounts: [...accounts].map(([name, totals]) => ({
        name,
        ...countsOf(totals),
      })),
    };
  });
}
