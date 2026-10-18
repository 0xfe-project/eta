import type { AgentUsage } from "@eta/client-contracts";
import { useTarget } from "@/queries/wire";

// What the models were used for, as the host counts it: the `usage` target's `agents` section,
// every agent with usage in the last 30 days. The providers and their models are the `providers`
// target (queries/providers.ts).

/**
 * One agent's usage over the rolling windows. `loaded` is false until the host has said anything;
 * `usage` is undefined for an agent that has none in the retention window.
 */
export function useAgentUsage(agentId: string | undefined): {
  usage: AgentUsage | undefined;
  loaded: boolean;
} {
  const agents = useTarget(agentId === undefined ? undefined : "usage")
    ?.sections.agents as readonly AgentUsage[] | undefined;
  return {
    usage: agents?.find((entry) => entry.agentId === agentId),
    loaded: agents !== undefined,
  };
}
