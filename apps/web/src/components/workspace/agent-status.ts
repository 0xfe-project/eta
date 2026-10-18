import type { AgentStatus } from "@eta/client-contracts";
import { translate } from "@/lib/i18n";

export const agentStatusLabels: Record<AgentStatus, string> = {
  get idle() {
    return translate("agents:status.idle");
  },
  get working() {
    return translate("agents:status.working");
  },
  get waiting_for_input() {
    return translate("agents:status.awaitingConfirmation");
  },
};
