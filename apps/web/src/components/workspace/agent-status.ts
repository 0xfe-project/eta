import type { Agent } from "@/queries/chat";
import { translate } from "@/lib/i18n";

export const agentStatusLabels: Record<Agent["status"], string> = {
  get idle() {
    return translate("agents:status.idle");
  },
  get starting() {
    return translate("common:status.starting");
  },
  get working() {
    return translate("agents:status.working");
  },
  get waiting_for_input() {
    return translate("agents:status.awaitingConfirmation");
  },
  get unavailable() {
    return translate("common:status.unavailable");
  },
};
