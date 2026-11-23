import type { TFunction } from "i18next";

/**
 * Translate terse English runtime summaries produced by drivers/manager into
 * everyday user-facing wording (DESIGN.md: plain language for Agent/tech UI).
 * Falls back to the original string when no known pattern matches.
 */
export function formatComputerSummary(
  summary: string,
  t: TFunction<readonly ["computer", "common"]>,
): string {
  const trimmed = summary.trim();
  if (trimmed === "") return "";

  if (trimmed.startsWith("Observed ") || trimmed.startsWith("observed ")) {
    const target = trimmed.slice("Observed ".length).trim();
    if (target !== "") {
      return t("computer:summary.observed", { target });
    }
  }

  const typedMatch = /^Typed\s+(\d+)\s+chars\b/i.exec(trimmed);
  if (typedMatch?.[1]) {
    return t("computer:summary.typed", { count: Number(typedMatch[1]) });
  }

  switch (trimmed) {
    case "User took over control":
    case "Taken over from overlay":
      return t("computer:summary.userTakeover");
    case "User click":
      return t("computer:summary.userClick");
    case "User type":
      return t("computer:summary.userType");
    case "User move":
      return t("computer:summary.userMove");
    case "Returned control to agent":
    case "Handed back to agent":
    case "Handed back from overlay":
      return t("computer:summary.handedBack");
    case "Paused realm":
    case "Paused from overlay":
      return t("computer:summary.paused");
    case "Resumed agent control":
    case "Resumed from overlay":
      return t("computer:summary.resumed");
    case "Stopped realm":
      return t("computer:summary.stopped");
    case "Closed realm":
      return t("computer:summary.closed");
    case "Brought to your screen":
    case "Brought to the user's screen":
      return t("computer:summary.promoted");
    case "Back to your desktop":
    case "Returned to the background":
    case "Switched back from the overlay":
      return t("computer:summary.demoted");
    default:
      return trimmed;
  }
}
