import type { LlmQuotaWindow, SourceQuota } from "@eta/client-contracts";

/**
 * The weekly window of a subscription, or nothing. A month is not a stand-in for a week: the
 * bar names one window, and an account that reports only a month reports nothing usable here.
 */
export function selectSourceQuota(
  windows: readonly LlmQuotaWindow[],
  now: number,
): SourceQuota | null {
  const weekly = windows.filter(
    (window) =>
      window.kind === "weekly" &&
      window.durationSeconds !== undefined &&
      Math.abs(window.durationSeconds - 7 * 86400) <= 3600,
  );
  const window = weekly[0];
  if (
    weekly.length !== 1 ||
    !window ||
    !Number.isFinite(window.used) ||
    window.used < 0 ||
    window.used > 100 ||
    (window.resetsAt !== undefined && !(Date.parse(window.resetsAt) > now))
  )
    return null;
  return {
    period: "weekly",
    usedPercent: window.used,
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
  };
}
