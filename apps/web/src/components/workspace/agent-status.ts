import type { Agent } from "@/queries/chat";

export const agentStatusLabels: Record<Agent["status"], string> = {
  idle: "空闲",
  working: "工作中",
  waiting_for_input: "等待确认",
  unavailable: "不可用",
};
