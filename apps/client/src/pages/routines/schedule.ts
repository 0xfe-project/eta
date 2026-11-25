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

/**
 * Minutes said as the nearest unit, "in 5 minutes" or "2 hours ago", in words of our own: the
 * native runtime has no relative-time formatter in `Intl`, and a page that calls it throws on render.
 */
function distance(minutes: number, direction: "In" | "Ago") {
  if (minutes < 1) return uiText("routineThisMinute");
  const unit = minutes >= 1440 ? "Day" : minutes >= 60 ? "Hour" : "Minute";
  const count = Math.floor(
    minutes / (unit === "Day" ? 1440 : unit === "Hour" ? 60 : 1),
  );
  return uiText(
    `routine${direction}${unit}${count === 1 ? "" : "s"}` as const,
    {
      count,
    },
  );
}

export function runAgo(at: number) {
  return distance(Math.floor((Date.now() - at) / 60_000), "Ago");
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
  return distance(Math.floor((at - Date.now()) / 60_000), "In");
}

// --- the viewer's clock ---------------------------------------------------------
//
// A routine keeps its own zone; the person looking at it reads its times on
// their own clock, with the zone it was set in named in brackets.

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The zones to choose from, the current one first when the runtime does not list it. The native
 * runtime has no `Intl.supportedValuesOf`; there the current zone is the only choice.
 */
export function timeZones(current: string) {
  const all =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  return all.includes(current) ? all : [current, ...all];
}

function viewerTimeZone() {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
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
    Number(parts.find((part) => part.type === type)!.value);
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
  return (
    Date.UTC(y, m, d, hh, mm) - Math.floor(date.getTime() / 60_000) * 60_000
  );
}

/** The instant timeZone's wall clock reads y-m-d hh:mm (fields may overflow). */
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

/** When the schedule fires in [from, to), read in timeZone; none for cron. */
function occurrences(
  schedule: RoutineSchedule,
  from: Date,
  to: Date,
  timeZone: string,
) {
  const times: Date[] = [];
  if (schedule.kind === "cron") return times;
  const start = wallClock(from, timeZone);
  const [hh = 0, mm = 0] =
    schedule.kind === "hourly" ? [0, 0] : schedule.time.split(":").map(Number);
  for (let i = 0; ; i++) {
    const time =
      schedule.kind === "hourly"
        ? zonedTime(timeZone, start.y, start.m, start.d, start.hh + i, 0)
        : zonedTime(timeZone, start.y, start.m, start.d + i, hh, mm);
    if (time >= to) return times;
    if (time < from) continue;
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

/** Whether two zones read the same wall clock, now and half a year on. */
function sameClock(a: string, b: string, now: Date) {
  if (a === b) return true;
  const later = new Date(now.getTime() + 182 * DAY);
  return (
    offset(now, a) === offset(now, b) && offset(later, a) === offset(later, b)
  );
}

/** A daily or weekly schedule moved to the viewer's clock, weekdays with it. */
function localSchedule(
  schedule: RoutineSchedule,
  timeZone: string,
  viewer: string,
  now: Date,
): RoutineSchedule {
  if (schedule.kind !== "daily" && schedule.kind !== "weekly") return schedule;
  const times = occurrences(
    schedule,
    now,
    new Date(now.getTime() + 7 * DAY),
    timeZone,
  );
  if (!times.length) return schedule;
  const first = wallClock(times[0]!, viewer);
  const time = `${pad(first.hh)}:${pad(first.mm)}`;
  if (schedule.kind === "daily") return { kind: "daily", time };
  const days = [
    ...new Set(
      times.map((at) => {
        const { y, m, d } = wallClock(at, viewer);
        return new Date(Date.UTC(y, m, d)).getUTCDay();
      }),
    ),
  ].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return { kind: "weekly", days, time };
}

/** The zone's name in the viewer's language: "Germany Time", "德国时间". */
function zoneName(timeZone: string, date: Date) {
  const name = (style: "shortGeneric" | "longGeneric" | "long") =>
    new Intl.DateTimeFormat(formatLocale(), { timeZone, timeZoneName: style })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ?? timeZone;
  const short = name("shortGeneric");
  if (/^[A-Z]{1,5}$/.test(short) || short.startsWith("GMT")) {
    const long = name("longGeneric");
    return long.startsWith("GMT") ? name("long") : long;
  }
  return short;
}

/**
 * The schedule on the viewer's clock, with what it was set to in brackets when
 * the routine's zone reads differently: "Daily at 16:30 (Daily at 09:30 Germany Time)".
 */
export function scheduleFor(
  schedule: RoutineSchedule,
  timeZone: string,
  now = new Date(),
) {
  const viewer = viewerTimeZone();
  if (schedule.kind === "hourly" || sameClock(timeZone, viewer, now))
    return scheduleLabel(schedule);
  const zone = zoneName(timeZone, now);
  return `${scheduleLabel(localSchedule(schedule, timeZone, viewer, now))}${
    schedule.kind === "cron"
      ? uiText("routineScheduleOriginZone", { zone })
      : uiText("routineScheduleOrigin", {
          zone,
          setting: scheduleLabel(schedule),
        })
  }`;
}

/** The time of day on the viewer's clock: "16:30". */
export function clockTime(at: number) {
  return new Date(at).toLocaleTimeString(formatLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/** "today", "tomorrow" or "21 Nov". */
export function dayWord(at: number) {
  const date = new Date(at);
  const today = new Date();
  const days = Math.round(
    (new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() -
      new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate(),
      ).getTime()) /
      DAY,
  );
  if (days === 0) return localizedText("today", "今天");
  if (days === 1) return localizedText("tomorrow", "明天");
  return shortDate(at);
}

/** "4 Nov", "11月4日". */
export function shortDate(at: number) {
  return new Date(at).toLocaleDateString(
    formatLocale() === "zh-CN" ? "zh-CN" : "en-GB",
    { day: "numeric", month: "short" },
  );
}

/** A report's date in the feed: "Wed 18 Nov · 16:30". */
export function feedTime(at: number) {
  const day = new Date(at).toLocaleDateString(
    formatLocale() === "zh-CN" ? "zh-CN" : "en-GB",
    { weekday: "short", day: "numeric", month: "short" },
  );
  return `${day.replace(",", "")} · ${clockTime(at)}`;
}

/** The next few times as the form previews them: "11-23 08:00 AM, 11-30 08:00 AM…". */
export function upcomingTimes(
  schedule: RoutineSchedule,
  timeZone: string,
  count = 3,
) {
  const now = new Date();
  let times: Date[] = [];
  try {
    times = occurrences(
      schedule,
      now,
      new Date(now.getTime() + 22 * DAY),
      timeZone,
    ).slice(0, count);
  } catch {
    return "";
  }
  if (!times.length) return "";
  return `${times
    .map(
      (at) =>
        `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${at.toLocaleTimeString(
          formatLocale(),
          { hour: "2-digit", minute: "2-digit" },
        )}`,
    )
    .join(", ")}…`;
}
