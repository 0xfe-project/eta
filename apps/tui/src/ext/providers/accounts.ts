// What the account screens say about an account or a connector. The key page and the states that
// need a new sign-in follow apps/web/src/components/workspace/llm-state.ts and
// apps/web/src/queries/llm.ts (`NEEDS_ACTION`).

import type { LlmConnectionState } from "@eta/client-contracts";
import type { Translate } from "../../i18n/messages";
import type { providersMessages } from "./messages";

type ProvidersKey = keyof typeof providersMessages.en;

const STATE_KEYS: Record<LlmConnectionState, ProvidersKey> = {
  active: "stateActive",
  disabled: "stateDisabled",
  needs_login: "stateNeedsLogin",
  rate_limited: "stateRateLimited",
  error: "stateError",
  degraded: "stateDegraded",
};

export function stateLabel(
  t: Translate<ProvidersKey>,
  state: LlmConnectionState,
): string {
  return t(STATE_KEYS[state]);
}

/** States the user has to sign in again from. */
export function needsSignIn(state: LlmConnectionState): boolean {
  return state === "needs_login" || state === "error";
}

/** Where the user creates a key, for the connectors that take one. */
export function keyPage(connectorId: string): string | undefined {
  return connectorId === "gemini"
    ? "https://aistudio.google.com/apikey"
    : undefined;
}

/** `m:ss` of what is left until `expiresAt`, never below zero. */
export function remainingText(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
