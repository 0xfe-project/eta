import type { Schedule } from "@/queries/routines";
import { formatLocale, translate } from "@/lib/i18n";

// How routines read: their schedules and their times.

const WEEKDAYS = [
  "common:weekdays.sunday",
  "common:weekdays.monday",
  "common:weekdays.tuesday",
  "common:weekdays.wednesday",
  "common:weekdays.thursday",
  "common:weekdays.friday",
  "common:weekdays.saturday",
] as const;

export function describeSchedule(schedule: Schedule) {
  switch (schedule.kind) {
    case "daily":
      return translate("routines:schedule.describe.daily", {
        time: schedule.time,
      });
    case "weekly":
      return translate("routines:schedule.describe.weekly", {
        weekdays: schedule.days
          .map((d) => translate(WEEKDAYS[d]))
          .join(formatLocale() === "zh-CN" ? "、" : ", "),
        time: schedule.time,
      });
    case "hourly":
      return schedule.every === 1
        ? translate("routines:schedule.describe.hourly")
        : translate("routines:schedule.describe.hourInterval", {
            count: schedule.every,
          });
    case "cron":
      return `cron ${schedule.cron}`;
  }
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** "今天 08:02", "明天 08:00", "10-11 08:03". */
export function when(iso: string) {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(formatLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  });
  const days = Math.round(
    (startOfDay(date).getTime() - startOfDay(new Date()).getTime()) /
      86_400_000,
  );
  const label =
    {
      [-1]: translate("common:time.yesterday"),
      0: translate("common:time.today"),
      1: translate("common:time.tomorrow"),
    }[days] ??
    `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, "0")}`;
  return `${label} ${time}`;
}

/** The wall clock in timeZone at date: its calendar fields, month from 0. */
function wallClock(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)!.value);
  return {
    y: get("year"),
    m: get("month") - 1,
    d: get("day"),
    hh: get("hour"),
    mm: get("minute"),
  };
}

/** How far timeZone's wall clock is ahead of UTC at date, in ms. */
function offset(date: Date, timeZone: string) {
  const { y, m, d, hh, mm } = wallClock(date, timeZone);
  const minute = Math.floor(date.getTime() / 60_000) * 60_000;
  return Date.UTC(y, m, d, hh, mm) - minute;
}

/**
 * The instant timeZone's wall clock reads y-m-d hh:mm (fields may overflow,
 * as with Date.UTC). Asked twice, so a daylight saving change between the
 * guess and the answer is seen.
 */
function zonedTime(
  timeZone: string,
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
) {
  const wall = Date.UTC(y, m, d, hh, mm);
  const guess = wall - offset(new Date(wall), timeZone);
  return new Date(wall - offset(new Date(guess), timeZone));
}

/**
 * When the schedule fires in [from, to), its times read in timeZone as the
 * server does; none for cron, which only the server evaluates.
 */
export function occurrences(
  schedule: Schedule,
  from: Date,
  to: Date,
  timeZone: string,
) {
  const times: Date[] = [];
  if (schedule.kind === "cron") return times;
  const start = wallClock(from, timeZone);
  const [hh, mm] =
    schedule.kind === "hourly" ? [0, 0] : schedule.time.split(":").map(Number);
  for (let i = 0; ; i++) {
    const time =
      schedule.kind === "hourly"
        ? zonedTime(timeZone, start.y, start.m, start.d, start.hh + i, 0)
        : zonedTime(timeZone, start.y, start.m, start.d + i, hh, mm);
    if (time >= to) return times;
    if (time < from) continue;
    // Hours and weekdays on timeZone's calendar, not the browser's.
    if (
      schedule.kind === "hourly"
        ? wallClock(time, timeZone).hh % schedule.every === 0
        : schedule.kind === "daily" ||
          schedule.days.includes(
            new Date(Date.UTC(start.y, start.m, start.d + i)).getUTCDay(),
          )
    )
      times.push(time);
  }
}
