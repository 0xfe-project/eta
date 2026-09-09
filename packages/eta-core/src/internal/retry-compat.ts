/**
 * Vendored gap-fill against the published @earendil-works/pi-ai@0.85.1:
 * `retryDelayMs` / `DEFAULT_MAX_AGENT_RETRY_DELAY_MS` exist in upstream git
 * but not in the published package. Upstream sync: delete when pi-ai ships them.
 * Source: pi packages/ai/src/utils/retry.ts (MIT, Mario Zechner).
 */

import type { RetryPolicy } from "@earendil-works/pi-ai";

/** Published RetryPolicy lacks `maxAgentDelayMs` (present in upstream git). */
export type AgentRetryPolicy = RetryPolicy & { maxAgentDelayMs?: number };

export const DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 60_000;

export function retryDelayMs(
	policy: { baseDelayMs: number; maxAgentDelayMs?: number },
	attempt: number,
): number {
	const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	const safeDelay = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
	return Math.min(safeDelay, policy.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS);
}
