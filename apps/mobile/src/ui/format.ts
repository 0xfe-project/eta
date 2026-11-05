import { t } from "../i18n";

const pad = (value: number) => String(value).padStart(2, "0");

/** `9:29` */
export function clock(at: number): string {
  const date = new Date(at);
  return `${date.getHours()}:${pad(date.getMinutes())}`;
}

const startOfDay = (at: number) => new Date(at).setHours(0, 0, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

/** 今天 `9:12`, `昨天 18:20`, `10/28 18:20`. */
export function moment(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (days === 0) return clock(at);
  if (days === 1) return `${t("common.yesterday")} ${clock(at)}`;
  const date = new Date(at);
  return `${date.getMonth() + 1}/${date.getDate()} ${clock(at)}`;
}

/** The list's right column: 刚刚, 3 分钟, 2 小时, 昨天, 10/28. */
export function ago(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return t("common.justNow");
  if (minutes < 60) return t("common.minutesAgo", { count: minutes });
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (days === 0)
    return t("common.hoursAgo", { count: Math.floor(minutes / 60) });
  if (days === 1) return t("common.yesterday");
  const date = new Date(at);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** What a failed call says, in the host's own words. */
export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
