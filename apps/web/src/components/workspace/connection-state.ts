import type { Connection } from "@/queries/llm";
import { translate } from "@/lib/i18n";

export const connectionStateLabels: Record<Connection["state"], string> = {
  get active() {
    return translate("providers:status.healthy");
  },
  get disabled() {
    return translate("providers:status.disabled");
  },
  get needs_login() {
    return translate("providers:status.needsLogin");
  },
  get rate_limited() {
    return translate("providers:status.quotaExhausted");
  },
  get error() {
    return translate("common:status.error");
  },
  get degraded() {
    return translate("providers:status.degraded");
  },
};

export function untilText(
  iso: string | undefined,
  verb = translate("providers:recovery.available"),
) {
  if (!iso) return "";
  const minutes = Math.ceil((new Date(iso).getTime() - Date.now()) / 60_000);
  if (minutes <= 0) return "";
  if (minutes < 60)
    return translate("providers:recovery.minutes", {
      action: verb,
      count: minutes,
    });
  const hours = Math.round(minutes / 60);
  return hours < 48
    ? translate("providers:recovery.hours", {
        action: verb,
        count: hours,
      })
    : translate("providers:recovery.days", {
        action: verb,
        count: Math.round(hours / 24),
      });
}
