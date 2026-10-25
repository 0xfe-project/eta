import type { AgentStatus, MemberStatus } from "@eta/client-contracts";
import { translate } from "@/lib/i18n";

/**
 * How someone in a conversation is spending its time.
 *
 * A member of a conversation has two states an agent seen on its own never shows — queued and
 * stopping — because a conversation is a lane: an agent can be waiting in it, and a stop can be
 * on its way. Both are worth a word on a row, so the table covers the whole of `MemberStatus`.
 */
export const memberStatusLabels: Record<MemberStatus, string> = {
  get idle() {
    return translate("agents:status.idle");
  },
  get queued() {
    return translate("agents:status.queued");
  },
  get working() {
    return translate("agents:status.working");
  },
  get waiting_for_input() {
    return translate("agents:status.awaitingConfirmation");
  },
  get stopping() {
    return translate("agents:status.stopping");
  },
};

/** An agent's own statuses are a subset of a member's; one table, so the two can never disagree. */
export const agentStatusLabels: Record<AgentStatus, string> =
  memberStatusLabels;
