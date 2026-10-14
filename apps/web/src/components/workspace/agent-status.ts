import type { Agent } from "@/queries/chat";
import { translate } from "@/lib/i18n";

export const agentStatusLabels: Record<Agent["status"], string> = {
  get idle() {
    return translate("空闲");
  },
  get starting() {
    return translate("启动中");
  },
  get working() {
    return translate("工作中");
  },
  get waiting_for_input() {
    return translate("等待确认");
  },
  get unavailable() {
    return translate("不可用");
  },
};
