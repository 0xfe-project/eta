/**
 * The agent events, published from one place.
 *
 * Two surfaces write agents — the internal routes and the product API the web speaks — and a
 * sidebar that hears about an edit made on one surface but not the other is a sidebar that lies.
 * So the publishing lives here, and both call it.
 *
 * The payload is *our* record, not the product's shape: the compat layer translates on the way
 * out (P2.4), which is what keeps these modules from learning a client's vocabulary.
 */
import type { EventHub } from "../http/events";
import type { AgentRecord } from "./store";

export function publishAgentUpdated(
  hub: EventHub | undefined,
  agent: AgentRecord,
): void {
  hub?.publish("agent.updated", { agent });
}

export function publishAgentDeleted(
  hub: EventHub | undefined,
  agentId: string,
): void {
  hub?.publish("agent.deleted", { agentId });
}
