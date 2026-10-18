/**
 * When a routine runs.
 *
 * The page offers four shapes and the clock needs one, so every shape is written down as five-field
 * cron and `croner` does the arithmetic in the routine's own time zone. Nothing here is a mirror of
 * a library's rules: a daily 02:30 on the night the clocks jump runs once at the first moment that
 * exists afterwards, and one that falls in an hour that happens twice runs the first time round,
 * because that is what the library answers and a schedule that disagreed with its own countdown
 * would be worse than either rule.
 */
import type { RoutineSchedule } from "@eta/client-contracts";
import { HOURLY_STEPS } from "@eta/client-contracts";
import { Cron } from "croner";

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MAX_CRON_LENGTH = 100;
const MAX_ZONE_LENGTH = 64;

/** A schedule read from untrusted JSON: the shape it says it has, or why it has none. */
export function parseSchedule(value: unknown): RoutineSchedule {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("schedule must be an object");
  const raw = value as Record<string, unknown>;
  const time = (): string => {
    if (typeof raw.time !== "string" || !TIME.test(raw.time))
      throw new TypeError(`a ${String(raw.kind)} schedule needs time as HH:MM`);
    return raw.time;
  };
  switch (raw.kind) {
    case "daily":
      return { kind: "daily", time: time() };
    case "weekly": {
      const days = raw.days;
      if (
        !Array.isArray(days) ||
        days.length === 0 ||
        !days.every(
          (day): day is number =>
            Number.isInteger(day) &&
            (day as number) >= 0 &&
            (day as number) <= 6,
        )
      )
        throw new TypeError(
          "a weekly schedule needs days: weekdays from 0 (Sunday) to 6",
        );
      return {
        kind: "weekly",
        days: [...new Set(days)].sort((a, b) => a - b),
        time: time(),
      };
    }
    case "hourly": {
      const every = HOURLY_STEPS.find((step) => step === raw.every);
      if (every === undefined)
        throw new TypeError(
          `an hourly schedule steps by ${HOURLY_STEPS.join(", ")} hours`,
        );
      return { kind: "hourly", every };
    }
    case "cron": {
      const cron = typeof raw.cron === "string" ? raw.cron.trim() : "";
      if (cron.length > MAX_CRON_LENGTH)
        throw new TypeError("that cron expression is too long");
      if (cron.split(/\s+/).length !== 5)
        throw new TypeError(
          "a cron schedule has five fields: minute hour day-of-month month day-of-week",
        );
      return { kind: "cron", cron };
    }
    default:
      throw new TypeError("a schedule is daily, weekly, hourly or cron");
  }
}

/** The schedule as five-field cron. */
export function cronOf(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
    case "cron":
      return schedule.cron;
    case "hourly":
      return `0 */${schedule.every} * * *`;
    case "daily":
    case "weekly": {
      const [hour, minute] = schedule.time.split(":").map(Number);
      const days = schedule.kind === "weekly" ? schedule.days.join(",") : "*";
      return `${minute} ${hour} * * ${days}`;
    }
  }
}

/**
 * The first time after `after` (epoch ms) that the schedule runs in `timezone`; undefined when it
 * never will (February 30th). An unknown zone or a cron the library rejects throws.
 */
export function nextRunAfter(
  schedule: RoutineSchedule,
  timezone: string,
  after: number,
): number | undefined {
  const next = new Cron(cronOf(schedule), { timezone }).nextRun(
    new Date(after),
  );
  return next === null ? undefined : next.getTime();
}

/**
 * Whether a schedule and zone can be put on the clock, or the reason they cannot. A schedule that
 * has no next time is refused here: accepting it would make a routine that is "enabled" and never
 * runs.
 */
export function checkSchedule(
  schedule: RoutineSchedule,
  timezone: string,
  now: number,
): void {
  if (timezone.trim() === "" || timezone.length > MAX_ZONE_LENGTH)
    throw new Error("timezone must be an IANA zone such as Asia/Shanghai");
  let next: number | undefined;
  try {
    next = nextRunAfter(schedule, timezone, now);
  } catch (error) {
    // The library names which half is wrong, which is more than the caller could say.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      /timezone/i.test(message)
        ? `unknown time zone: ${timezone}`
        : `invalid schedule: ${message}`,
    );
  }
  if (next === undefined) throw new Error("that schedule never runs");
}

/** The schedule in words, for the run's prompt. */
export function describeSchedule(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
    case "daily":
      return `every day at ${schedule.time}`;
    case "weekly":
      return `every ${schedule.days.map((day) => WEEKDAYS[day]).join(", ")} at ${schedule.time}`;
    case "hourly":
      return schedule.every === 1
        ? "every hour"
        : `every ${schedule.every} hours`;
    case "cron":
      return `cron "${schedule.cron}"`;
  }
}

/** A moment as the zone's wall clock reads it: `Sunday 2026-10-18 09:30`. */
export function wallClock(at: number, timezone: string): string {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
  }).format(at);
  // The Swedish format is ISO 8601 with a space, which is the one a model reads without effort.
  const stamp = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
  return `${day} ${stamp}`;
}
