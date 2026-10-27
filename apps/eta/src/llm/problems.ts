/**
 * The gateway's failures and reasons, as codes the client translates.
 *
 * `LLM_CODES` (`@eta/client-contracts`) is the closed set; this file says what each means and
 * which params it carries. `message` is an English diagnostic for logs and never drives what the
 * UI says. The wire forwards an error's `problem` (code and params) with the failed reply.
 *
 *   code                    params              meaning
 *   login_expired                               the provider no longer accepts the login; sign in again
 *   invalid_api_key                             the provider rejects the API key
 *   quota_exhausted                             the account's quota is used up; retry_at says when it recovers
 *   rate_limited                                too many requests; retry_at says when it recovers
 *   upstream_error          status              the provider refused the account (HTTP 402/403)
 *   upstream_unstable       status              a transient provider failure; the account recovers by itself
 *   upstream_unreachable                        the provider could not be reached
 *   account_disabled        provider            the user disabled the account
 *   model_disabled                              the model is disabled
 *   model_quota_exhausted   provider            the account's quota for the model is used up
 *   model_forbidden         provider, status    the account may not use the model
 *   model_not_found         provider            the provider does not offer the model
 *   no_connection           provider            no account is linked for the provider
 *   check_failed                                the account could not be checked; its status is unchanged
 *   usage_unavailable                           the subscription windows could not be read
 *   no_token                                    the account has no usable token
 *   login_start_failed      provider            the login could not be started
 *   login_timeout                               the API key entry timed out
 *   device_code_timeout                         the device code expired before it was approved
 *   login_failed                                the provider ended the login with an error
 *   login_save_failed                           the login succeeded but the credential could not be kept
 *   api_key_required                            an empty API key was submitted
 *   duplicate_api_key                           the API key was added before
 *   key_check_unavailable   provider            the provider could not be reached to check the key
 *   not_found                                   unknown connector, connection or login
 *   invalid_request                             the request is malformed
 *   unsupported                                 the connector does not support the operation
 *   gateway_unavailable                         any other failure inside the gateway
 */
import type { LlmCode, LlmParams, LlmProblem } from "@eta/client-contracts";

export function problem(
  code: LlmCode,
  message: string,
  params?: LlmParams,
): LlmProblem {
  return params === undefined ? { code, message } : { code, message, params };
}

/** A refusal the gateway explains: the wire passes `problem` (code and params) to the client. */
export class LlmError extends Error {
  readonly problem: { code: LlmCode; params?: LlmParams };
  constructor(
    code: LlmCode,
    message: string,
    params?: LlmParams,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LlmError";
    this.problem = params === undefined ? { code } : { code, params };
  }
  get code(): LlmCode {
    return this.problem.code;
  }
  /** The problem as a view carries it. */
  get view(): LlmProblem {
    return problem(this.problem.code, this.message, this.problem.params);
  }
}

export const notFound = (): LlmError => new LlmError("not_found", "Not found.");

/** The code of an `LlmError`, else undefined. */
export const codeOf = (error: unknown): LlmCode | undefined =>
  error instanceof LlmError ? error.code : undefined;
