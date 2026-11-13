// Adapted from apps/web/src/lib/llm-problem.ts and the failure branch of `wireErrorMessage` in
// apps/web/src/queries/wire.ts. Unlike the web page, a gateway code this client does not know
// shows the host's message alone.

import type { LlmCode } from "@eta/client-contracts";
import type { Locale } from "../../config/types";
import type { MessageCatalog } from "../../extensions/types";
import { LLM_CODES } from "@eta/client-contracts";
import { WireError } from "../../connection/wire";
import { translatorFor } from "../../i18n/messages";
import { kitMessages, llmProblemMessages } from "./messages";

const KNOWN: ReadonlySet<string> = new Set(LLM_CODES);
// A gateway code without its text fails the type check here.
const PROBLEM_TEXTS: MessageCatalog<LlmCode> = llmProblemMessages;

function isLlmCode(code: string): code is LlmCode {
  return KNOWN.has(code);
}

/** A gateway problem as it arrives on the wire or in the `llm` target's state. */
export interface ProblemLike {
  code: string;
  /** The host's diagnostic, shown only for a code this client does not know. */
  message: string;
  params?:
    | {
        provider?: string | number | undefined;
        status?: string | number | undefined;
      }
    | undefined;
}

/** A gateway problem in the user's language; a code this client does not know is its `message`. */
export function llmProblemText(problem: ProblemLike, locale: Locale): string {
  if (!isLlmCode(problem.code)) return problem.message;
  return translatorFor(PROBLEM_TEXTS, locale)(problem.code, {
    provider: problem.params?.provider ?? "",
    status: problem.params?.status ?? "",
  });
}

/**
 * What to tell the user about a failed call: that there is no connection or no answer, a gateway
 * code in the user's language, otherwise the host's own words. Anything that is not a
 * `WireError` is shown as `String(error)`.
 */
export function callErrorText(error: unknown, locale: Locale): string {
  if (!(error instanceof WireError)) return String(error);
  const t = translatorFor(kitMessages, locale);
  switch (error.code) {
    case "disconnected":
      return t("disconnected");
    case "timeout":
      return t("timeout");
    case "server":
      return error.problem === undefined
        ? error.message
        : llmProblemText(
            {
              code: error.problem.code,
              message: error.message,
              params: error.problem.params,
            },
            locale,
          );
  }
}
