import type { Schedule } from "@/queries/routines";

// How routines read: their schedules and their times.

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function describeSchedule(schedule: Schedule) {
  switch (schedule.kind) {
    case "daily":
      return `每天 ${schedule.time}`;
    case "weekly":
      return `每周${schedule.days.map((d) => WEEKDAYS[d]).join("、")} ${schedule.time}`;
    case "hourly":
      return schedule.every === 1 ? "每小时" : `每 ${schedule.every} 小时`;
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
  const time = date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const days = Math.round(
    (startOfDay(date).getTime() - startOfDay(new Date()).getTime()) /
      86_400_000,
  );
  const label =
    { [-1]: "昨天", 0: "今天", 1: "明天" }[days] ??
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
