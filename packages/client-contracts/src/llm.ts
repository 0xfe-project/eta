/**
 * The `llm` target: model subscriptions and API keys the LLM gateway holds.
 *
 * The gateway (CLIProxyAPI in a child process, see docs/architecture/llm-gateway.md) logs in to a
 * Codex or Grok subscription with a device code, or takes a Google AI Studio API key, keeps the
 * credentials, and serves the models they unlock as one provider, `llm`. A model of it is named
 * `llm:<model id>` like any other. Three sections: `accounts` (who is connected and in what
 * state), `models` (the catalog, with what each model can do right now) and `quota` (the
 * subscription windows the providers report: 5 hours, weekly).
 */

/** The provider id the gateway's models go under: `llm:gpt-5`. */
export const LLM_PROVIDER_ID = "llm";

/** The actions this target has. One list, so the wire and the plugin cannot disagree. */
export const LLM_ACTIONS = [
  "refresh",
  "loginStart",
  "loginPoll",
  "loginSubmit",
  "loginCancel",
  "setEnabled",
  "remove",
] as const;
export type LlmAction = (typeof LLM_ACTIONS)[number];

/** How the gateway treats an account right now. */
export type LlmConnectionState =
  | "active"
  | "disabled"
  | "needs_login"
  | "rate_limited"
  | "error"
  | "degraded";

/**
 * Every code the gateway reports a failure or a reason with: a closed set. What each means and
 * which params it carries is in the gateway (`apps/eta/src/llm/problems.ts`).
 */
export const LLM_CODES = [
  "login_expired",
  "invalid_api_key",
  "quota_exhausted",
  "rate_limited",
  "upstream_error",
  "upstream_unstable",
  "upstream_unreachable",
  "account_disabled",
  "model_disabled",
  "model_quota_exhausted",
  "model_forbidden",
  "model_not_found",
  "no_connection",
  "check_failed",
  "usage_unavailable",
  "no_token",
  "login_start_failed",
  "login_timeout",
  "device_code_timeout",
  "login_failed",
  "login_save_failed",
  "api_key_required",
  "duplicate_api_key",
  "key_check_unavailable",
  "not_found",
  "invalid_request",
  "unsupported",
  "gateway_unavailable",
] as const;
export type LlmCode = (typeof LLM_CODES)[number];

/** What a code may carry: a provider's display name, an HTTP status. */
export interface LlmParams {
  provider?: string | undefined;
  status?: number | undefined;
}

/**
 * Why something failed or is unavailable, as a code the client translates. `message` is an
 * English diagnostic for logs; the UI never shows it unless it does not know the code (a newer
 * gateway than this client).
 */
export interface LlmProblem {
  code: LlmCode;
  message: string;
  params?: LlmParams | undefined;
}

/** A way to connect an account. `flow` says which form the login takes. */
export interface LlmConnector {
  id: string;
  name: string;
  flow: "oauth_device" | "oauth_redirect" | "api_key";
}

/** One connected account or key. It never carries a token. */
export interface LlmConnection {
  id: string;
  connector: string;
  label: string;
  plan?: string | undefined;
  state: LlmConnectionState;
  error?: LlmProblem | undefined;
  /** ISO time the account recovers by itself, when it does. */
  retryAt?: string | undefined;
  createdAt: string;
  /** When the account was last checked against its provider, and why that check failed. */
  checkedAt?: string | undefined;
  checkError?: LlmProblem | undefined;
}

export interface LlmAccounts {
  /** False while the gateway is starting. */
  ready: boolean;
  connectors: LlmConnector[];
  connections: LlmConnection[];
}

export type LlmModelStatus = "available" | "degraded" | "unavailable";

export interface LlmModel {
  id: string;
  connector: string;
  name: string;
  contextWindow?: number | undefined;
  status: LlmModelStatus;
  /** Whether requests are let through: a degraded model is. */
  available: boolean;
  reason?: LlmProblem | undefined;
  retryAt?: string | undefined;
}

/** One subscription window. `used` is the percent already consumed, 0 to 100. */
export interface LlmQuotaWindow {
  kind: "5h" | "weekly" | "monthly";
  used: number;
  resetsAt?: string | undefined;
  durationSeconds?: number | undefined;
}

/** What a provider reports about one account's subscription. */
export interface LlmQuota {
  connectionId: string;
  plan?: string | undefined;
  windows: LlmQuotaWindow[];
  /** Set when the read failed; the windows are then empty. */
  error?: LlmProblem | undefined;
}

export interface LlmLogin {
  id: string;
  connector: string;
  flow: LlmConnector["flow"];
  status: "pending" | "succeeded" | "failed" | "expired";
  /** Where to enter the code. */
  url?: string | undefined;
  userCode?: string | undefined;
  expiresAt: string;
  /** Why the login ended without succeeding. */
  error?: LlmProblem | undefined;
}

export interface LlmArgs {
  refresh: Record<string, never>;
  loginStart: { connector: string };
  loginPoll: { id: string };
  /** An API key, for the connectors whose flow is `api_key`. */
  loginSubmit: { id: string; apiKey: string };
  loginCancel: { id: string };
  setEnabled: { id: string; enabled: boolean };
  remove: { id: string };
}
