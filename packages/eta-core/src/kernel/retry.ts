/**
 * Retry policy — ported from eta-agent's internal/retry-compat.ts, which
 * exists because the published pi-ai lacks `maxAgentDelayMs` (present in
 * upstream git). Delete the vendored piece when pi-ai ships it.
 *
 * Source: pi packages/ai/src/utils/retry.ts (MIT, Mario Zechner).
 */
import type { RetryPolicy } from "@earendil-works/pi-ai";

/** Published RetryPolicy lacks `maxAgentDelayMs` (present in upstream git). */
export type AgentRetryPolicy = RetryPolicy & { maxAgentDelayMs?: number };

export const DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 60_000;

export const DEFAULT_RETRY_POLICY: AgentRetryPolicy = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxAgentDelayMs: DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
};

/** Exponential backoff, capped: baseDelay * 2^(attempt-1), ceiling maxAgentDelayMs. */
export function retryDelayMs(
  policy: { baseDelayMs: number; maxAgentDelayMs?: number },
  attempt: number,
): number {
  const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const safeDelay = Number.isSafeInteger(delay)
    ? delay
    : Number.MAX_SAFE_INTEGER;
  return Math.min(
    safeDelay,
    policy.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
  );
}

/** The attempt budget a run works with, normalized from the policy. */
export interface NormalizedRetryPolicy {
  /** Total attempts, the first call included. */
  maxAttempts: number;
  baseDelayMs: number;
  maxAgentDelayMs: number;
}

/** Port of eta-agent's normalizedRetryPolicy: a disabled policy means one attempt. */
export function normalizedRetryPolicy(
  policy: AgentRetryPolicy,
): NormalizedRetryPolicy {
  return {
    maxAttempts: policy.enabled ? policy.maxRetries + 1 : 1,
    baseDelayMs: policy.baseDelayMs,
    maxAgentDelayMs: policy.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
  };
}

/** When the retry after `attempt` may start. Clamped, so a huge delay cannot overflow. */
export function retryNotBefore(
  policy: Pick<AgentRetryPolicy, "baseDelayMs" | "maxAgentDelayMs">,
  attempt: number,
  now = Date.now(),
): number {
  const sum = now + retryDelayMs(policy, attempt);
  return Number.isSafeInteger(sum) ? sum : Number.MAX_SAFE_INTEGER;
}

/**
 * Wait until a wall-clock instant, abortable (port of eta-agent's
 * drive/retry.ts). The timer is re-armed in chunks so a delay longer than
 * setTimeout's 32-bit ceiling still works, and an abort rejects with the
 * signal's own reason rather than a generic error.
 */
export function waitUntil(
  notBefore: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      // eslint-disable-next-line ts/no-use-before-define -- onAbort and cleanup call each other
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    const check = (): void => {
      const remaining = notBefore - Date.now();
      if (remaining <= 0) {
        cleanup();
        resolve();
        return;
      }
      timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    else check();
  });
}
