import type { ComputerRuntime } from "@/queries/tasks";

export const runtimeStateLabels: Record<ComputerRuntime["state"], string> = {
  waiting: "等待配对",
  pairing: "需授权：等待批准配对",
  needs_approval: "需授权：运行时有变化，等待批准",
  online: "服务可用",
  offline: "connector 离线",
  unavailable: "服务未启动或不可用",
  unknown: "状态未知：无法读取中继",
};

export function assignmentStatus(state?: string, online?: boolean) {
  if (state === "online" || (!state && online)) return "可执行性未检查";
  return (
    runtimeStateLabels[state as ComputerRuntime["state"]] ??
    "连接不可用，状态未确认"
  );
}
