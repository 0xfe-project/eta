/**
 * What went wrong with a request, as a fact rather than a sentence.
 *
 * A run that fails has to be diagnosable from what it left behind. The
 * provider already said why ("HTTP 400, Messages with role 'tool' must be a
 * response to a preceding message with 'tool_calls'"); before this file the
 * kernel kept only "the stream emitted error before start", which tells nobody
 * anything. So the classification lives here, once, and three layers read it:
 * the generation loop (should this be retried?), the runner (what is the run's
 * outcome?), and the app (what does the reply row say?).
 *
 * The rule the codes exist for is the product rule: every state of a
 * conversation has a way forward that does not need a person to push it, and
 * the only states that legitimately stop are auth and money (401/402).
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** The kinds of failure the system has a distinct answer for. */
export type FailureCode =
  /** The provider refused the request's shape (400/422). Repairing may fix it. */
  | "invalid_request"
  /** Throttled (429). Waiting helps. */
  | "rate_limit"
  /** The provider broke (5xx, overloaded). Waiting helps. */
  | "server_error"
  /** The request never reached an answer (DNS, TCP, TLS, timeout, cut stream). */
  | "network"
  /** The credential was refused (401/403). Nothing helps until it is fixed. */
  | "auth"
  /** The account is out of money or over its plan (402, insufficient_quota). */
  | "quota"
  /** The provider does not have this model (404). Switching models helps. */
  | "model_not_found"
  /** The request did not fit the window. Compacting helps. */
  | "context_overflow"
  /** The process died under the run; a restart is not a provider failure. */
  | "restart"
  /** The run was cancelled on purpose. Not a failure; classified so it is not "unknown". */
  | "aborted"
  /** Nothing recognisable. Treated as transient, because guessing "fatal" strands a session. */
  | "unknown";

/** One failed request, as much as the system knows about it. */
export interface RunFailure {
  code: FailureCode;
  /** The provider the request went to (`deepseek`, `openai`, `anthropic`…). */
  provider?: string | undefined;
  /** The model id the request named. */
  modelId?: string | undefined;
  /** The HTTP status, when the provider sent one. */
  httpStatus?: number | undefined;
  /**
   * The provider's own words — the body's message, not a paraphrase of it. This
   * is the field that answers "why did it fail" without reading the logs.
   */
  providerMessage?: string | undefined;
  /** Which attempt this was, the first call counting as 1. */
  attempt: number;
  /** Whether the same request, tried again, has a chance of working. */
  retryable: boolean;
  /** What the person can do about it, when anything can be done. */
  remedy?: string | undefined;
}

/** What the provider's wording is measured against. */
export interface FailureContext {
  /** The provider, when the message does not carry one. */
  provider?: string | undefined;
  /** The model id, when the message does not carry one. */
  modelId?: string | undefined;
  /** The attempt the failed message came from (the first call is 1). */
  attempt?: number | undefined;
}

/** Codes that are worth another attempt with the same request. */
const RETRYABLE: ReadonlySet<FailureCode> = new Set<FailureCode>([
  "rate_limit",
  "server_error",
  "network",
  "unknown",
]);

export function isRetryableFailureCode(code: FailureCode): boolean {
  return RETRYABLE.has(code);
}

/**
 * What a person can do about a failure. Only the codes with an action get a
 * line: an action invented for a transient failure is noise.
 */
export function remedyFor(code: FailureCode): string | undefined {
  switch (code) {
    case "auth":
      return "Check the API key for this provider, then retry this reply.";
    case "quota":
      return "Top up the provider's account, then retry this reply.";
    case "model_not_found":
      return "Switch this session to a model the provider has.";
    case "invalid_request":
      return "The transcript was repaired and the request retried; if this repeats, the request itself is wrong.";
    case "context_overflow":
      return "Compact this session, then retry.";
    default:
      return undefined;
  }
}

/** How many characters of the provider's body are kept. */
export const MAX_PROVIDER_MESSAGE_CHARS = 2_000;

/**
 * The HTTP status the provider reported, if it is in the text.
 *
 * pi-ai folds the status into the message it hands back, in one of a few
 * shapes: `400: {…body…}`, `Azure OpenAI API error (400): …`,
 * `403 status code (no body)`. Anything else is not a status, and guessing one
 * from a stray number would be worse than not having it.
 */
export function httpStatusOf(text: string): number | undefined {
  const leading = /^(?:[^:(){}]*?\s)?\((\d{3})\)/.exec(text);
  if (leading !== null) return Number(leading[1]);
  const colon = /^(\d{3})\s*:/.exec(text);
  if (colon !== null) return Number(colon[1]);
  const statusCode = /\b(\d{3})\s+status\s+code\b/i.exec(text);
  if (statusCode !== null) return Number(statusCode[1]);
  return undefined;
}

/**
 * The provider's own words: the body's `error.message` when the text carries a
 * JSON body, else the text with the status prefix taken off. Truncated, because
 * a gateway may send a whole HTML page.
 */
export function providerMessageOf(
  text: string,
  status?: number,
): string | undefined {
  const body = jsonBody(text);
  if (body !== undefined) {
    const message = body.error?.message ?? body.message ?? body.error?.code;
    if (typeof message === "string" && message.trim() !== "")
      return truncate(message.trim());
  }
  const stripped = text
    .replace(/^(?:[^:(){}]*?\s)?\((\d{3})\)\s*:?\s*/, "")
    .replace(/^(\d{3})\s*:\s*/, "")
    .trim();
  const rest = stripped === "" || stripped === String(status) ? "" : stripped;
  return rest === "" ? undefined : truncate(rest);
}

function truncate(text: string): string {
  return text.length <= MAX_PROVIDER_MESSAGE_CHARS
    ? text
    : `${text.slice(0, MAX_PROVIDER_MESSAGE_CHARS)}… [${text.length - MAX_PROVIDER_MESSAGE_CHARS} more characters]`;
}

interface ErrorBody {
  error?: { message?: unknown; code?: unknown; type?: unknown };
  message?: unknown;
}

/** The JSON object the text carries, when it carries one. */
function jsonBody(text: string): ErrorBody | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const body = parsed as ErrorBody & Record<string, unknown>;
    // `{"error":"some string"}` is a body too, just not an object.
    if (typeof body.error === "string")
      return { error: { message: body.error } };
    if (typeof body.message === "string" || typeof body.error === "object")
      return body;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Wording that means each code when the provider sent no status at all. */
const PATTERNS: readonly (readonly [FailureCode, RegExp])[] = [
  [
    "quota",
    /insufficient_quota|insufficient balance|insufficient funds|out of budget|quota exceeded|exceeded your current quota|billing|free-?tier|payment required|余额|欠费/i,
  ],
  [
    "context_overflow",
    /context[ _-]?(?:length|window|size)|prompt is too long|too many tokens|exceeds? (?:the )?(?:maximum|available)|greater than the context|exceeded model token limit|input length should be|reduce the length of the messages|request too large|too large for (?:the|this) model/i,
  ],
  [
    "auth",
    /invalid[_ ]?api[_ ]?key|incorrect api key|authentication|unauthorized|not authorized|api key|api[_ ]?key[_ ]?invalid|permission denied/i,
  ],
  [
    "rate_limit",
    /rate.?limit|too many requests|requests per (?:min|second|day)|429/i,
  ],
  [
    "model_not_found",
    /model[_ ]not[_ ](?:exist|found)|no such model|unknown model|invalid model|not a valid model|model .{0,40}does not exist/i,
  ],
  [
    "server_error",
    /overloaded|service.?unavailable|internal.?server.?error|server.?error|bad gateway|gateway time-?out|50[0234]/i,
  ],
  [
    "network",
    /fetch failed|network|econnreset|econnrefused|enotfound|eai_again|etimedout|socket hang up|other side closed|connection (?:error|lost|refused|reset)|upstream.?connect|getaddrinfo|timed? out|timeout|stream ended before|ended without|websocket/i,
  ],
];

/**
 * Classify one failed assistant message.
 *
 * The status wins when there is one: a provider that said 402 meant money, no
 * matter which words followed. Wording is the fallback for transports that
 * never produced a status (a fetch throwing `ENOTFOUND`), and `unknown` is the
 * last resort — and it is retryable, because "I do not recognise this" is not a
 * reason to end a conversation.
 */
export function classifyFailure(
  message: Pick<
    AssistantMessage,
    "stopReason" | "errorMessage" | "provider" | "model"
  >,
  context: FailureContext = {},
): RunFailure {
  const attempt = context.attempt ?? 1;
  const provider = message.provider ?? context.provider;
  const modelId = message.model ?? context.modelId;
  const text = message.errorMessage ?? "";
  const httpStatus = httpStatusOf(text);
  const providerMessage = providerMessageOf(text, httpStatus);

  const code =
    message.stopReason === "aborted" ? "aborted" : codeOf(text, httpStatus);

  return {
    code,
    ...(provider === undefined ? {} : { provider }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(providerMessage === undefined ? {} : { providerMessage }),
    attempt,
    retryable: isRetryableFailureCode(code),
    ...(remedyFor(code) === undefined ? {} : { remedy: remedyFor(code) }),
  };
}

function codeOf(text: string, httpStatus: number | undefined): FailureCode {
  // Money first, whatever the status says: a 400 carrying "Insufficient
  // Balance" is still a wallet problem, and retrying it burns time.
  if (
    /insufficient_quota|insufficient balance|out of budget|quota exceeded|余额|欠费/i.test(
      text,
    )
  )
    return "quota";
  // An oversized request is refused as a bad request by most providers (400),
  // and the answer to it is a compaction, not a different request body — so the
  // wording is read before the status is believed.
  if (
    httpStatus === undefined ||
    httpStatus === 400 ||
    httpStatus === 413 ||
    httpStatus === 422
  ) {
    const overflow = PATTERNS.find(([, pattern]) => pattern.test(text));
    if (overflow?.[0] === "context_overflow") return "context_overflow";
  }
  switch (httpStatus) {
    case 400:
    case 413:
    case 422:
      return "invalid_request";
    case 401:
    case 403:
      return "auth";
    case 404:
      return "model_not_found";
    case 402:
      return "quota";
    case 408:
    case 425:
    case 429:
      return "rate_limit";
    default:
      if (httpStatus !== undefined && httpStatus >= 500) return "server_error";
  }
  for (const [code, pattern] of PATTERNS) {
    if (pattern.test(text)) return code;
  }
  return "unknown";
}

/**
 * One sentence a person can read, with the provider's own words in it.
 *
 * Used where a failure becomes text: the reply row, the run's `error`, the
 * `run_failed` entry. It says what happened, to whom, and what to do — and it
 * never invents a reason the provider did not give.
 */
export function describeFailure(failure: RunFailure): string {
  const who = [failure.provider, failure.modelId]
    .filter((part): part is string => part !== undefined && part !== "")
    .join("/");
  const at = who === "" ? "" : ` (${who})`;
  const said =
    failure.providerMessage === undefined ? "" : `: ${failure.providerMessage}`;
  const status =
    failure.httpStatus === undefined ? "" : ` HTTP ${failure.httpStatus}`;
  const head = `${headline(failure.code)}${at}${status}${said}`;
  return failure.remedy === undefined ? head : `${head} — ${failure.remedy}`;
}

function headline(code: FailureCode): string {
  switch (code) {
    case "invalid_request":
      return "The provider rejected the request";
    case "rate_limit":
      return "The provider is rate limiting this key";
    case "server_error":
      return "The provider returned a server error";
    case "network":
      return "The request never completed";
    case "auth":
      return "The provider refused the credential";
    case "quota":
      return "The provider's account is out of money";
    case "model_not_found":
      return "The provider has no such model";
    case "context_overflow":
      return "The request does not fit the model's context window";
    case "restart":
      return "The server restarted before this reply finished";
    case "aborted":
      return "The reply was stopped";
    case "unknown":
      return "The request failed";
  }
}
