import type { Connection } from "@/queries/llm";
import { translate } from "@/lib/i18n";

export const connectionStateLabels: Record<Connection["state"], string> = {
  get active() {
    return translate("正常");
  },
  get disabled() {
    return translate("已停用");
  },
  get needs_login() {
    return translate("需要重新登录");
  },
  get rate_limited() {
    return translate("额度已用尽");
  },
  get error() {
    return translate("出错");
  },
  get degraded() {
    return translate("暂时故障");
  },
};

export function untilText(
  iso: string | undefined,
  verb = translate("服务恢复"),
) {
  if (!iso) return "";
  const minutes = Math.ceil((new Date(iso).getTime() - Date.now()) / 60_000);
  if (minutes <= 0) return "";
  if (minutes < 60)
    return translate("约 {{value1}} 分钟后{{value2}}", {
      value1: minutes,
      value2: verb,
      count: minutes,
    });
  const hours = Math.round(minutes / 60);
  return hours < 48
    ? translate("约 {{value1}} 小时后{{value2}}", {
        value1: hours,
        value2: verb,
        count: hours,
      })
    : translate("约 {{value1}} 天后{{value2}}", {
        value1: Math.round(hours / 24),
        value2: verb,
        count: Math.round(hours / 24),
      });
}
