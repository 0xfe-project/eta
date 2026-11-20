import type {
  LlmConnection,
  LlmQuota,
  LlmQuotaWindow,
} from "@eta/client-contracts";
import { isMonthDuration } from "@eta/client-contracts";
import { cleanup, signal } from "nsh";
import { formatLocale } from "../../../i18n";

export function billingClock() {
  const now = signal(Date.now());
  const ticker = setInterval(() => now.set(Date.now()), 1000);
  cleanup(() => clearInterval(ticker));
  return now;
}

export function accountQuota(
  quotas: LlmQuota[] | undefined,
  account: LlmConnection,
) {
  const matches = quotas?.filter(
    (item) =>
      item.connectionId === account.id &&
      item.quotaRevision === account.quotaRevision,
  );
  return matches?.length === 1 ? matches[0] : undefined;
}

export function monthlyWindows(quota: LlmQuota | undefined) {
  return (quota?.windows ?? [])
    .filter(
      (window) =>
        window.kind === "monthly" &&
        (window.durationSeconds === undefined ||
          isMonthDuration(window.durationSeconds)),
    )
    .sort(
      (a, b) =>
        (a.durationSeconds ?? Infinity) - (b.durationSeconds ?? Infinity),
    );
}

export function currentPercent(
  quota: LlmQuota,
  window: LlmQuotaWindow,
  now: number,
): number | undefined {
  if (
    quota.error ||
    Date.parse(quota.observedAt ?? "") + 1_800_000 <= now ||
    Date.parse(window.resetsAt ?? "") <= now
  )
    return undefined;
  const used = window.used;
  return Number.isFinite(used) &&
    used >= 0 &&
    used <= 100 &&
    (used !== 0 || Number.isFinite(Date.parse(quota.observedAt ?? "")))
    ? used
    : undefined;
}

export function percentText(used: number) {
  if (used > 0 && used < 0.1) return "<0.1%";
  if (used < 100 && used > 99.9) return ">99.9%";
  return `${used.toLocaleString(formatLocale(), { maximumFractionDigits: 1 })}%`;
}

export function localTime(iso?: string) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "";
  return new Intl.DateTimeFormat(formatLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "shortOffset",
  }).format(new Date(iso));
}
