/**
 * Fixed follow-up text emitted when a scheduled loop fires (prompts module owns
 * all model-visible strings; ETA-CORE-PLAN Part C).
 */

export function loopFollowUp(id: string, note: string): string {
	return `[loop ${id}] ${note}`;
}
