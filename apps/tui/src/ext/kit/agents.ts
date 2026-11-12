import type { AgentView } from "@eta/client-contracts";
import { ordinaryAgents } from "./captain";
import { useTarget } from "./wire-hooks";

/** The host's agents but Captain, kept live; undefined until the list has come. */
export function useAgents(): AgentView[] | undefined {
  const list = useTarget("agents")?.sections.list as AgentView[] | undefined;
  return list === undefined ? undefined : ordinaryAgents(list);
}

export type FoundAgent =
  | { agent: AgentView }
  | { ambiguous: AgentView[] }
  | { none: true };

/**
 * The agent the user means by `text`, tried in this order: an exact id, an exact name ignoring
 * case, then the start of a name ignoring case. The first rule that fits decides; when it fits
 * more than one agent, the result is ambiguous. Blank text finds none.
 */
export function findAgent(
  agents: readonly AgentView[],
  text: string,
): FoundAgent {
  const wanted = text.trim();
  if (wanted === "") return { none: true };
  const byId = agents.find((agent) => agent.id === wanted);
  if (byId !== undefined) return { agent: byId };
  const lower = wanted.toLowerCase();
  for (const fits of [
    (name: string) => name === lower,
    (name: string) => name.startsWith(lower),
  ]) {
    const found = agents.filter((agent) => fits(agent.name.toLowerCase()));
    if (found.length === 1) return { agent: found[0] };
    if (found.length > 1) return { ambiguous: found };
  }
  return { none: true };
}
