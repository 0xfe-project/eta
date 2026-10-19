import type { LlmCode, LlmParams } from "@eta/client-contracts";
import { LLM_CODES } from "@eta/client-contracts";
import { translate } from "@/lib/i18n";

/** What the gateway says is wrong: a code and its values. `message` is a diagnostic for logs. */
export interface ProblemLike {
  code: string;
  message: string;
  params?: LlmParams | undefined;
}

const KNOWN: ReadonlySet<string> = new Set(LLM_CODES);

/** The locale key of each code (`llm:problems.<key>`): a missing code is a type error. */
const KEYS = {
  login_expired: "loginExpired",
  invalid_api_key: "invalidApiKey",
  quota_exhausted: "quotaExhausted",
  rate_limited: "rateLimited",
  upstream_error: "upstreamError",
  upstream_unstable: "upstreamUnstable",
  upstream_unreachable: "upstreamUnreachable",
  account_disabled: "accountDisabled",
  model_disabled: "modelDisabled",
  model_quota_exhausted: "modelQuotaExhausted",
  model_forbidden: "modelForbidden",
  model_not_found: "modelNotFound",
  no_connection: "noConnection",
  check_failed: "checkFailed",
  usage_unavailable: "usageUnavailable",
  no_token: "noToken",
  login_start_failed: "loginStartFailed",
  login_timeout: "loginTimeout",
  device_code_timeout: "deviceCodeTimeout",
  login_failed: "loginFailed",
  login_save_failed: "loginSaveFailed",
  api_key_required: "apiKeyRequired",
  duplicate_api_key: "duplicateApiKey",
  key_check_unavailable: "keyCheckUnavailable",
  not_found: "notFound",
  invalid_request: "invalidRequest",
  unsupported: "unsupported",
  gateway_unavailable: "gatewayUnavailable",
} as const satisfies Record<LlmCode, string>;

function isLlmCode(code: string): code is LlmCode {
  return KNOWN.has(code);
}

/**
 * A gateway problem in the user's language. A code this client doesn't know (a newer gateway)
 * shows the code and the gateway's own diagnostic rather than nothing.
 */
export function llmProblemText(problem: ProblemLike): string {
  if (!isLlmCode(problem.code))
    return translate("llm:problems.unknown", {
      code: problem.code,
      message: problem.message,
    });
  return translate(`llm:problems.${KEYS[problem.code]}`, {
    provider: problem.params?.provider ?? "",
    status: problem.params?.status ?? "",
  });
}
