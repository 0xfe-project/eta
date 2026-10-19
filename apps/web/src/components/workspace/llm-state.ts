import type { LlmConnectionState } from "@eta/client-contracts";
import { translate } from "@/lib/i18n";

/** What an account's state is called. */
export const connectionStateLabels: Record<LlmConnectionState, string> = {
  get active() {
    return translate("llm:status.healthy");
  },
  get disabled() {
    return translate("llm:status.disabled");
  },
  get needs_login() {
    return translate("llm:status.needsLogin");
  },
  get rate_limited() {
    return translate("llm:status.quotaExhausted");
  },
  get error() {
    return translate("llm:status.error");
  },
  get degraded() {
    return translate("llm:status.degraded");
  },
};

/**
 * How long until an account recovers by itself, or a quota window resets; empty when it already
 * has or never says.
 */
export function recoveryText(
  iso: string | undefined,
  kind: "recovery" | "reset" = "recovery",
): string {
  if (!iso) return "";
  const minutes = Math.ceil((new Date(iso).getTime() - Date.now()) / 60_000);
  if (minutes <= 0) return "";
  if (minutes < 60) return translate(`llm:${kind}.minutes`, { count: minutes });
  const hours = Math.round(minutes / 60);
  return hours < 48
    ? translate(`llm:${kind}.hours`, { count: hours })
    : translate(`llm:${kind}.days`, { count: Math.round(hours / 24) });
}

/** The window a quota entry is named by. */
export function windowLabel(kind: string): string {
  switch (kind) {
    case "5h":
      return translate("common:time.windows.fiveHours");
    case "weekly":
      return translate("common:time.windows.weekly");
    case "monthly":
      return translate("common:time.windows.monthly");
    default:
      return kind;
  }
}
