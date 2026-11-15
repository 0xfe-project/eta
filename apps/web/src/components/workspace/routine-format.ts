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

/** "Today 08:02", "Tomorrow 08:00", "10-11 08:03". */
export function when(at: string | number) {
  const date = new Date(at);
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

// --- the viewer's clock -----------------------------------------------------------
//
// A routine keeps its own zone (Captain makes them in the host's); the person
// looking at it reads every time on their own clock, so the schedule and the
// next run never show one moment as two numbers.

export function viewerTimeZone() {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const DAY = 86_400_000;

/** Whether two zones read the same wall clock, now and half a year on. */
function sameClock(a: string, b: string, now = new Date()) {
  if (a === b) return true;
  const later = new Date(now.getTime() + 182 * DAY);
  return (
    offset(now, a) === offset(now, b) && offset(later, a) === offset(later, b)
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Day of the week of timeZone's calendar at date, 0 for Sunday. */
function weekday(date: Date, timeZone: string) {
  const { y, m, d } = wallClock(date, timeZone);
  return new Date(Date.UTC(y, m, d)).getUTCDay();
}

/**
 * The schedule as the viewer's clock reads it: a daily or weekly time moved
 * to the viewer's zone, its weekdays moved with it when the day changes. Every
 * N hours and cron are left as they are.
 */
export function localSchedule(
  schedule: Schedule,
  timeZone: string,
  viewer = viewerTimeZone(),
  now = new Date(),
): Schedule {
  if (
    (schedule.kind !== "daily" && schedule.kind !== "weekly") ||
    sameClock(timeZone, viewer, now)
  )
    return schedule;
  // One week of runs holds each weekday once.
  const times = occurrences(
    schedule,
    now,
    new Date(now.getTime() + 7 * DAY),
    timeZone,
  );
  if (times.length === 0) return schedule;
  const first = wallClock(times[0], viewer);
  const time = `${pad(first.hh)}:${pad(first.mm)}`;
  if (schedule.kind === "daily") return { kind: "daily", time };
  const days = [...new Set(times.map((t) => weekday(t, viewer)))].sort(
    // Monday first, as the form lists them.
    (a, b) => ((a + 6) % 7) - ((b + 6) % 7),
  );
  return { kind: "weekly", days, time };
}

/** The zone's name in the viewer's language: "德国时间", "Central European Time". */
function zoneName(timeZone: string, date = new Date()) {
  const name = (style: "shortGeneric" | "longGeneric" | "long") =>
    new Intl.DateTimeFormat(formatLocale(), { timeZone, timeZoneName: style })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value ?? timeZone;
  // Chinese names the place ("德国时间"); English short names are bare
  // letters ("ET"), and a zone with no name reads "GMT+…".
  const short = name("shortGeneric");
  if (/^[A-Z]{1,5}$/.test(short) || short.startsWith("GMT")) {
    const long = name("longGeneric");
    return long.startsWith("GMT") ? name("long") : long;
  }
  return short;
}

/**
 * What the routine was set to in its own zone, when the viewer's clock
 * differs: for the tooltip on its next run. Null when nothing was moved.
 */
export function scheduleSetting(
  schedule: Schedule,
  timeZone: string,
  viewer = viewerTimeZone(),
  now = new Date(),
) {
  if (schedule.kind === "hourly" || sameClock(timeZone, viewer, now))
    return null;
  const zone = zoneName(timeZone, now);
  if (schedule.kind === "cron")
    return translate("routines:next.cronIn", { zone });
  return translate("routines:next.setIn", {
    zone,
    setting:
      schedule.kind === "daily" ? schedule.time : describeSchedule(schedule),
  });
}

/**
 * The schedule on the viewer's clock, with what it was set to in brackets when
 * the routine's zone reads differently: "每天 16:00（德国时间 每天 09:00）".
 */
export function describeScheduleFor(
  schedule: Schedule,
  timeZone: string,
  viewer = viewerTimeZone(),
  now = new Date(),
) {
  const local = describeSchedule(
    localSchedule(schedule, timeZone, viewer, now),
  );
  if (schedule.kind === "hourly" || sameClock(timeZone, viewer, now))
    return local;
  const zone = zoneName(timeZone, now);
  return (
    local +
    (schedule.kind === "cron"
      ? translate("routines:next.originZone", { zone })
      : translate("routines:next.origin", {
          zone,
          setting: describeSchedule(schedule),
        }))
  );
}

/** The full time on the viewer's clock: "11-16 周一 16:00". */
export function fullTime(at: number, viewer = viewerTimeZone()) {
  const date = new Date(at);
  const { m, d, hh, mm } = wallClock(date, viewer);
  return translate("routines:next.fullTime", {
    date: `${pad(m + 1)}-${pad(d)}`,
    weekday: translate(WEEKDAYS[weekday(date, viewer)]),
    time: `${pad(hh)}:${pad(mm)}`,
  });
}

/** How long until at: minutes or hours within a day, then tomorrow or N days on the viewer's calendar. */
function untilNext(at: number, now = Date.now(), viewer = viewerTimeZone()) {
  const left = at - now;
  if (left < 3_600_000)
    return translate("routines:next.inMinutes", {
      count: Math.max(1, Math.ceil(left / 60_000)),
    });
  if (left < DAY)
    return translate("routines:next.inHours", {
      count: Math.floor(left / 3_600_000),
    });
  const day = (t: number) => {
    const { y, m, d } = wallClock(new Date(t), viewer);
    return Date.UTC(y, m, d);
  };
  const days = Math.round((day(at) - day(now)) / DAY);
  return days <= 1
    ? translate("routines:next.tomorrow")
    : translate("routines:next.inDays", { count: days });
}

/** How long a run has been going: "45 秒", "2 分钟", "1 小时 5 分". */
function runningFor(startedAt: number, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60)
    return translate("routines:next.seconds", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return translate("routines:next.minutes", { count: minutes });
  return translate("common:time.durationHoursMinutes", {
    hours: Math.floor(minutes / 60),
    minutes: minutes % 60,
  });
}

export type NextRunState =
  | { kind: "running"; text: string }
  | { kind: "paused" | "captainOff" | "never"; text: string }
  | { kind: "next"; text: string; at: number };

/**
 * What the bottom right of a routine's row says: running, paused, no further
 * time, Captain off (nothing runs, so no time is promised), or the next one.
 */
export function nextRunState(
  routine: {
    enabled: boolean;
    nextRunAt: number | null;
    runs: { status: string; startedAt: number }[];
  },
  captainOn: boolean,
  now = Date.now(),
  viewer = viewerTimeZone(),
): NextRunState {
  const last = routine.runs[0];
  if (last?.status === "running")
    return {
      kind: "running",
      text: translate("routines:next.running", {
        duration: runningFor(last.startedAt, now),
      }),
    };
  if (!routine.enabled)
    return { kind: "paused", text: translate("routines:next.paused") };
  if (routine.nextRunAt === null)
    return { kind: "never", text: translate("routines:next.never") };
  if (!captainOn)
    return { kind: "captainOff", text: translate("routines:next.captainOff") };
  return {
    kind: "next",
    at: routine.nextRunAt,
    text: translate("routines:next.upcoming", {
      when: untilNext(routine.nextRunAt, now, viewer),
    }),
  };
}
