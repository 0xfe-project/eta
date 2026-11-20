import type { RoutineSchedule, RoutineSummary } from "@eta/client-contracts";
import { formatLocale, localizedText, uiText } from "../../i18n";

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function weekday(day: number) {
  return formatLocale() === "zh-CN"
    ? `周${"日一二三四五六"[day]}`
    : weekdays[day]!;
}

export function scheduleLabel(schedule: RoutineSchedule) {
  switch (schedule.kind) {
    case "daily":
      return uiText("routineEveryDayAt", { time: schedule.time });
    case "weekly":
      return uiText("routineDaysAt", {
        days: schedule.days
          .map(weekday)
          .join(formatLocale() === "zh-CN" ? "、" : ", "),
        time: schedule.time,
      });
    case "hourly":
      return uiText("everyHours", { hours: schedule.every });
    case "cron":
      return schedule.cron;
  }
}

export function mobileSchedule(schedule: RoutineSchedule) {
  return schedule.kind === "daily"
    ? localizedText(`Every day ${schedule.time}`, `每天 ${schedule.time}`)
    : scheduleLabel(schedule);
}

export function runAgo(at: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  const formatter = new Intl.RelativeTimeFormat(formatLocale(), {
    numeric: "auto",
  });
  if (minutes >= 1440)
    return formatter.format(-Math.floor(minutes / 1440), "day");
  if (minutes >= 60) return formatter.format(-Math.floor(minutes / 60), "hour");
  return formatter.format(-minutes, "minute");
}

export function runHistory(runs: RoutineSummary["runs"]) {
  const history = runs
    .slice(0, 7)
    .reverse()
    .map((run) => run.status);
  return Array.from(
    { length: 7 },
    (_, index) => history[index - (7 - history.length)] ?? null,
  );
}

export function routineTime(at: number) {
  return new Date(at).toLocaleString(
    formatLocale() === "zh-CN" ? "zh-CN" : "en-GB",
    {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    },
  );
}

export function clockDistance(at: number) {
  const minutes = Math.max(0, Math.floor((at - Date.now()) / 60_000));
  const formatter = new Intl.RelativeTimeFormat(formatLocale(), {
    numeric: "auto",
  });
  if (minutes >= 1440)
    return formatter.format(Math.floor(minutes / 1440), "day");
  if (minutes >= 60) return formatter.format(Math.floor(minutes / 60), "hour");
  return formatter.format(minutes, "minute");
}
