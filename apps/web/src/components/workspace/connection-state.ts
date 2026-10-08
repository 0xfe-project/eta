import type { Connection } from "@/queries/llm";

export const connectionStateLabels: Record<Connection["state"], string> = {
  active: "正常",
  disabled: "已停用",
  needs_login: "需要重新登录",
  rate_limited: "额度已用尽",
  error: "出错",
};

export function untilText(iso: string | undefined) {
  if (!iso) return "";
  const minutes = Math.ceil((new Date(iso).getTime() - Date.now()) / 60_000);
  if (minutes <= 0) return "";
  if (minutes < 60) return `约 ${minutes} 分钟后恢复`;
  const hours = Math.round(minutes / 60);
  return hours < 48
    ? `约 ${hours} 小时后恢复`
    : `约 ${Math.round(hours / 24)} 天后恢复`;
}
