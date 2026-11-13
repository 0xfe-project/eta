import { translate } from "@/lib/i18n";

/** The page where the user creates a key, for connectors that take one; none for the rest. */
export function connectorKeyUrl(id: string): string | undefined {
  switch (id) {
    case "gemini":
      return "https://aistudio.google.com/apikey";
    default:
      return undefined;
  }
}

/** The guidance shown with a connector's login, by connector id; none for one we don't know. */
export function connectorHint(id: string): string | undefined {
  switch (id) {
    case "codex":
      return translate("llm:connectorHints.codex");
    case "xai":
      return translate("llm:connectorHints.xai");
    default:
      return undefined;
  }
}

/** How long until a quota window resets; empty when it already has or never says. */
export function resetText(iso: string | undefined): string {
  if (!iso) return "";
  const minutes = Math.ceil((new Date(iso).getTime() - Date.now()) / 60_000);
  if (minutes <= 0) return "";
  if (minutes < 60) return translate("llm:reset.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  return hours < 48
    ? translate("llm:reset.hours", { count: hours })
    : translate("llm:reset.days", { count: Math.round(hours / 24) });
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
