import type { ThinkingLevel } from "@eta/client-contracts";

/**
 * The thinking levels the pickers offer, lowest first. (The kernel has two more, `xhigh` and
 * `max`, which only some models accept; a picker that offers them would offer refusals.)
 */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
] as const satisfies readonly ThinkingLevel[];
