import { cleanup, signal } from "nsh";
import { formatLocale } from "../../../i18n";

export function billingClock() {
  const now = signal(Date.now());
  const ticker = setInterval(() => now.set(Date.now()), 1000);
  cleanup(() => clearInterval(ticker));
  return now;
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
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}
