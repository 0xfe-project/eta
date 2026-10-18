/**
 * Telling a conversation that its steward changed.
 *
 * Nothing is moved when a steward is switched: the old agent keeps its session and stays a member
 * (it can still be mentioned), and the new one gets its session when it is first woken, and is
 * then told what it has not seen. What the timeline gets is one system row saying so, which every
 * member reads at its next wake like anything else said there.
 */
import type { MessageView } from "@eta/client-contracts";
import type { AgentStore } from "../agents/store";
import type { Timeline } from "./timeline";

export function announceSteward(
  deps: { agents: AgentStore; timeline: Timeline },
  conversationId: string,
  from: string | null,
  to: string | null,
): MessageView | undefined {
  if (from === to) return undefined;
  const name = (id: string | null): string =>
    id === null ? "nobody" : (deps.agents.get(id)?.name ?? "a deleted agent");
  const text =
    to === null
      ? `${name(from)} is no longer the steward.`
      : from === null
        ? `${name(to)} is now the steward.`
        : `${name(to)} is now the steward, taking over from ${name(from)}.`;
  return deps.timeline.system(conversationId, text, {
    event: "steward",
    from,
    to,
  });
}
