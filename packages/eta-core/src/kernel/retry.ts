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
export function retryDelayMs(policy: { baseDelayMs: number; maxAgentDelayMs?: number }, attempt: number): number {
	const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	const safeDelay = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
	return Math.min(safeDelay, policy.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS);
}
