/**
 * What an account and a model can do right now, derived from what CPA reports.
 *
 * A credential file comes with CPA's routing state: its status and its cooldowns, each scoped to
 * the credential or to one model and labelled with a reason (`CooldownSnapshotForAuth` in CPA).
 * CPA records a request's failure on the model it was for, and keeps routing the account's other
 * models, so only what is about the credential takes the account down: a rejected login, a
 * credential-wide quota, or a credential-wide cooldown (before any model was tried). Cooldowns end
 * by themselves, whatever the sticky status says.
 *
 * An API key lives in CPA's config, and CPA does not report the routing state of those: a key is
 * active unless it is disabled, and the gateway's own check (`gateway.ts`) says when the provider
 * rejects it.
 */
import type {
  AuthFileEntry,
  CooldownView,
  CredentialSummary,
} from "@cpajs/cpa/client";
import type {
  LlmConnection,
  LlmModelStatus,
  LlmProblem,
} from "@eta/client-contracts";
import { problem } from "./problems";

/** A connection with what the gateway needs to act on it; the view drops the rest. */
export interface Connection extends LlmConnection {
  /** CPA's `auth_index`: stable for a credential, and the connection's id. */
  readonly authIndex: string;
  /** A credential file, by name; or an API key in CPA's config, under `api-keys.<provider>`. */
  readonly source:
    | { kind: "file"; name: string; accountId?: string | undefined }
    | { kind: "key"; provider: string; key: string };
  /** The credential's cooldowns that have not ended, for its models. */
  readonly cooldowns: readonly CooldownView[];
  /** What CPA listed it as, to ask for its models with. */
  readonly summary?: CredentialSummary | undefined;
}

/** The parts of a connection a client sees. */
export function connectionView(connection: Connection): LlmConnection {
  const {
    authIndex: _index,
    source: _source,
    cooldowns: _cooldowns,
    summary: _summary,
    ...view
  } = connection;
  return view;
}

const LOGIN_REJECTED = new Set(["unauthorized", "invalid_grant"]);

/** A connection from one of CPA's credential files. */
export function fileConnection(
  entry: AuthFileEntry,
  connector: string,
  now: number,
): Connection {
  const cooldowns = (entry.cooldowns ?? []).filter(
    (cooldown) => Date.parse(cooldown.retry_at) > now,
  );
  const base = {
    id: entry.auth_index,
    authIndex: entry.auth_index,
    connector,
    label: entry.email ?? (entry.label || entry.name),
    ...(entry.id_token?.plan_type === undefined
      ? {}
      : { plan: entry.id_token.plan_type }),
    createdAt: new Date(
      Date.parse(entry.created_at ?? entry.modtime ?? "") || now,
    ).toISOString(),
    source: {
      kind: "file" as const,
      name: entry.name,
      accountId: entry.id_token?.chatgpt_account_id,
    },
    cooldowns,
  };
  if (entry.disabled || entry.status === "disabled")
    return { ...base, state: "disabled" };
  if (loginRejected(entry, cooldowns))
    return {
      ...base,
      state: "needs_login",
      error: problem(
        "login_expired",
        "The login is no longer accepted; sign in again.",
      ),
    };
  const account = cooldowns.find((cooldown) => cooldown.scope === "credential");
  if (account === undefined) return { ...base, state: "active" };
  const retryAt = account.retry_at;
  const status = account.http_status;
  switch (account.reason) {
    case "credential_quota":
      return {
        ...base,
        state: "rate_limited",
        retryAt,
        error: problem(
          "quota_exhausted",
          "The account quota is used up; it recovers by itself.",
        ),
      };
    case "quota":
      return {
        ...base,
        state: "rate_limited",
        retryAt,
        error: problem(
          "rate_limited",
          "Too many requests; the account recovers by itself.",
        ),
      };
    case "payment_required": {
      const code = status ?? 403;
      return {
        ...base,
        state: "error",
        retryAt,
        error: problem(
          "upstream_error",
          `The provider refused the account (HTTP ${code}).`,
          { status: code },
        ),
      };
    }
    default:
      return { ...base, state: "degraded", retryAt, error: transient(status) };
  }
}

/** A connection for an API key in CPA's config. */
export function keyConnection(input: {
  authIndex: string;
  connector: string;
  provider: string;
  key: string;
  disabled: boolean;
  createdAt: string;
}): Connection {
  return {
    id: input.authIndex,
    authIndex: input.authIndex,
    connector: input.connector,
    // Its last four characters, as providers show keys.
    label: input.key.length >= 8 ? `…${input.key.slice(-4)}` : input.authIndex,
    state: input.disabled ? "disabled" : "active",
    createdAt: input.createdAt,
    source: { kind: "key", provider: input.provider, key: input.key },
    cooldowns: [],
  };
}

/** A credential the provider no longer accepts. A 401 is about the credential, whichever model it came from. */
function loginRejected(
  entry: AuthFileEntry,
  cooldowns: readonly CooldownView[],
): boolean {
  if (cooldowns.some((cooldown) => LOGIN_REJECTED.has(cooldown.reason)))
    return true;
  return (
    entry.status === "error" &&
    looksLikeAuthFailure(entry.status_message.toLowerCase())
  );
}

function looksLikeAuthFailure(message: string): boolean {
  return [
    "refresh",
    "invalid_grant",
    "unauthorized",
    "token expired",
    "token_expired",
    "revoked",
    "re-login",
    "relogin",
  ].some((word) => message.includes(word));
}

/** A failure that clears by itself: a provider error with its status, or none when unreachable. */
function transient(status: number | undefined): LlmProblem {
  return status !== undefined && status > 0
    ? problem(
        "upstream_unstable",
        `The provider failed temporarily (HTTP ${status}); retrying.`,
        { status },
      )
    : problem(
        "upstream_unreachable",
        "The provider could not be reached; retrying.",
      );
}

export interface ModelState {
  status: LlmModelStatus;
  reason?: LlmProblem | undefined;
  retryAt?: string | undefined;
}

/** What one account can do for a model now. `name` is the provider's display name. */
export function modelState(
  connection: Connection,
  model: string,
  name: string,
  apiKey: boolean,
): ModelState {
  switch (connection.state) {
    case "active":
      break;
    case "degraded":
      return {
        status: "degraded",
        reason: connection.error,
        retryAt: connection.retryAt,
      };
    default:
      return {
        status: "unavailable",
        reason: connectionReason(name, apiKey, connection),
        retryAt: connection.retryAt,
      };
  }
  const cooldown = connection.cooldowns.find(
    (entry) => entry.scope === "model" && entry.model_key === model,
  );
  if (cooldown === undefined) return { status: "available" };
  const retryAt = cooldown.retry_at;
  switch (cooldown.reason) {
    case "quota":
    case "credential_quota":
      return {
        status: "unavailable",
        retryAt,
        reason: problem(
          "model_quota_exhausted",
          `${name} account: the quota for this model is used up.`,
          { provider: name },
        ),
      };
    case "payment_required": {
      const status = cooldown.http_status ?? 403;
      return {
        status: "unavailable",
        retryAt,
        reason: problem(
          "model_forbidden",
          `${name} account may not use this model (HTTP ${status}).`,
          { provider: name, status },
        ),
      };
    }
    case "not_found":
    case "model_not_supported":
      return {
        status: "unavailable",
        retryAt,
        reason: problem(
          "model_not_found",
          `${name} does not offer this model (HTTP 404).`,
          { provider: name },
        ),
      };
    default:
      return {
        status: "degraded",
        retryAt,
        reason: transient(cooldown.http_status),
      };
  }
}

/** Why a model is unavailable because of the account serving it (or the lack of one). */
export function connectionReason(
  name: string,
  apiKey: boolean,
  connection: Connection | undefined,
): LlmProblem | undefined {
  const provider = { provider: name };
  switch (connection?.state) {
    case "needs_login":
      return apiKey
        ? problem("invalid_api_key", `${name} API key is invalid.`, provider)
        : problem(
            "login_expired",
            `${name} login is no longer accepted.`,
            provider,
          );
    case "rate_limited":
      return problem(
        "quota_exhausted",
        `${name} account quota is used up.`,
        provider,
      );
    case "error":
      return connection.error === undefined
        ? problem("upstream_error", `${name} account is unavailable.`, provider)
        : {
            ...connection.error,
            params: { ...provider, ...connection.error.params },
          };
    case "disabled":
      return problem(
        "account_disabled",
        `${name} account is disabled.`,
        provider,
      );
    case "degraded":
      return connection.error;
    default:
      return problem(
        "no_connection",
        `No ${name} account is linked.`,
        provider,
      );
  }
}

/** How bad a connection's state is: the most actionable one explains a connector's models. */
export function severity(state: LlmConnection["state"]): number {
  return {
    needs_login: 5,
    error: 4,
    rate_limited: 3,
    degraded: 2,
    disabled: 1,
    active: 0,
  }[state];
}

export const modelRank = (status: LlmModelStatus): number =>
  ({ available: 2, degraded: 1, unavailable: 0 })[status];
