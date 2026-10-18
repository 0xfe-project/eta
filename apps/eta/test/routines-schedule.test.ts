/**
 * Schedules: the four shapes the page offers, read as untrusted JSON, and when each one runs next
 * in a time zone. The library does the arithmetic; what is pinned here is what a routine's owner
 * is promised, which is mostly what happens on the two nights a year the clocks move.
 */
import type { RoutineSchedule } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import {
  checkSchedule,
  cronOf,
  describeSchedule,
  nextRunAfter,
  parseSchedule,
  wallClock,
} from "../src/routines/schedule";

const at = (iso: string): number => Date.parse(iso);

/** The next `count` times, as ISO strings, starting after `from`. */
function runs(
  schedule: RoutineSchedule,
  timezone: string,
  from: string,
  count: number,
): string[] {
  const times: string[] = [];
  let cursor = at(from);
  for (let index = 0; index < count; index++) {
    const next = nextRunAfter(schedule, timezone, cursor);
    if (next === undefined) break;
    times.push(new Date(next).toISOString());
    cursor = next;
  }
  return times;
}

describe("reading a schedule from JSON", () => {
  it("accepts the four shapes and says them as cron", () => {
    const daily = parseSchedule({ kind: "daily", time: "07:30" });
    expect(daily).toEqual({ kind: "daily", time: "07:30" });
    expect(cronOf(daily)).toBe("30 7 * * *");

    const weekly = parseSchedule({
      kind: "weekly",
      days: [5, 1, 3, 1],
      time: "09:05",
    });
    // Sorted, and each day once.
    expect(weekly).toEqual({ kind: "weekly", days: [1, 3, 5], time: "09:05" });
    expect(cronOf(weekly)).toBe("5 9 * * 1,3,5");

    const hourly = parseSchedule({ kind: "hourly", every: 4 });
    expect(cronOf(hourly)).toBe("0 */4 * * *");

    const cron = parseSchedule({ kind: "cron", cron: "  */15 9-17 * * 1-5 " });
    expect(cron).toEqual({ kind: "cron", cron: "*/15 9-17 * * 1-5" });
    expect(cronOf(cron)).toBe("*/15 9-17 * * 1-5");
  });

  it.each([
    ["not an object", "daily"],
    ["an array", []],
    ["no kind", { time: "07:30" }],
    ["an unknown kind", { kind: "monthly", time: "07:30" }],
    ["a time without its zero", { kind: "daily", time: "7:30" }],
    ["a time past midnight", { kind: "daily", time: "24:00" }],
    ["a minute past 59", { kind: "daily", time: "07:60" }],
    [
      "a weekly schedule with no days",
      { kind: "weekly", days: [], time: "07:30" },
    ],
    ["a weekday 7", { kind: "weekly", days: [7], time: "07:30" }],
    ["a fractional weekday", { kind: "weekly", days: [1.5], time: "07:30" }],
    ["an hourly step that does not divide a day", { kind: "hourly", every: 5 }],
    ["an hourly step of zero", { kind: "hourly", every: 0 }],
    ["a cron of four fields", { kind: "cron", cron: "* * * *" }],
    ["a cron of six fields (seconds)", { kind: "cron", cron: "* * * * * *" }],
    ["a cron nickname", { kind: "cron", cron: "@daily" }],
    ["a cron that is not text", { kind: "cron", cron: 5 }],
  ])("refuses %s", (_name, value) => {
    expect(() => parseSchedule(value)).toThrow();
  });
});

describe("checking a schedule against a zone", () => {
  const now = at("2026-10-18T00:00:00Z");
  const daily: RoutineSchedule = { kind: "daily", time: "09:00" };

  it("accepts a zone and a schedule the clock can run", () => {
    expect(() => checkSchedule(daily, "Asia/Shanghai", now)).not.toThrow();
    expect(() => checkSchedule(daily, "UTC", now)).not.toThrow();
  });

  it("refuses a zone nobody knows, and says so", () => {
    expect(() => checkSchedule(daily, "Mars/Base", now)).toThrow(
      /unknown time zone: Mars\/Base/,
    );
    expect(() => checkSchedule(daily, "", now)).toThrow(/IANA zone/);
  });

  it("refuses a cron the library rejects", () => {
    expect(() =>
      checkSchedule({ kind: "cron", cron: "61 * * * *" }, "UTC", now),
    ).toThrow(/invalid schedule/);
  });

  it("refuses a schedule that never happens, rather than enabling a routine that never runs", () => {
    // February 30th.
    expect(() =>
      checkSchedule({ kind: "cron", cron: "0 0 30 2 *" }, "UTC", now),
    ).toThrow(/never runs/);
  });
});

describe("when a schedule runs next", () => {
  it("is the zone's wall clock, whatever the host's: the same instant, three zones", () => {
    const daily: RoutineSchedule = { kind: "daily", time: "09:00" };
    const from = "2026-10-18T00:00:00Z";
    expect(runs(daily, "UTC", from, 1)).toEqual(["2026-10-18T09:00:00.000Z"]);
    // UTC+8, no daylight saving: 09:00 there is 01:00 here, and tomorrow's is a day on.
    expect(runs(daily, "Asia/Shanghai", from, 2)).toEqual([
      "2026-10-18T01:00:00.000Z",
      "2026-10-19T01:00:00.000Z",
    ]);
    // A half-hour zone.
    expect(
      runs({ kind: "daily", time: "08:00" }, "Asia/Kolkata", from, 1),
    ).toEqual(["2026-10-18T02:30:00.000Z"]);
    // Behind UTC, and still on daylight time in October.
    expect(runs(daily, "America/Los_Angeles", from, 1)).toEqual([
      "2026-10-18T16:00:00.000Z",
    ]);
  });

  it("is strictly after the moment it is asked from, not at it", () => {
    const daily: RoutineSchedule = { kind: "daily", time: "09:00" };
    expect(runs(daily, "UTC", "2026-10-18T09:00:00Z", 1)).toEqual([
      "2026-10-19T09:00:00.000Z",
    ]);
    expect(runs(daily, "UTC", "2026-10-18T08:59:59.999Z", 1)).toEqual([
      "2026-10-18T09:00:00.000Z",
    ]);
  });

  it("weekly names weekdays by the zone's calendar, not UTC's", () => {
    const weekly: RoutineSchedule = {
      kind: "weekly",
      days: [1, 3, 5],
      time: "09:00",
    };
    // 2026-10-18 is a Sunday. In Shanghai Monday 09:00 is Monday 01:00 UTC; in Los Angeles it is
    // Monday 16:00 UTC; and in Auckland, 09:00 Monday is still Sunday in UTC.
    expect(runs(weekly, "Asia/Shanghai", "2026-10-18T00:00:00Z", 3)).toEqual([
      "2026-10-19T01:00:00.000Z",
      "2026-10-21T01:00:00.000Z",
      "2026-10-23T01:00:00.000Z",
    ]);
    expect(
      runs(weekly, "America/Los_Angeles", "2026-10-18T00:00:00Z", 1),
    ).toEqual(["2026-10-19T16:00:00.000Z"]);
    expect(runs(weekly, "Pacific/Auckland", "2026-10-18T00:00:00Z", 1)).toEqual(
      ["2026-10-18T20:00:00.000Z"],
    );
  });

  it("hourly steps by the zone's hours, so a half-hour zone is on its own half-hours", () => {
    // 07:00 UTC is 12:30 in Kolkata; the next hour divisible by 4 there is 16:00, which is 10:30 UTC.
    expect(
      runs(
        { kind: "hourly", every: 4 },
        "Asia/Kolkata",
        "2026-10-18T07:00:00Z",
        2,
      ),
    ).toEqual(["2026-10-18T10:30:00.000Z", "2026-10-18T14:30:00.000Z"]);
    expect(
      runs({ kind: "hourly", every: 1 }, "UTC", "2026-10-18T07:10:00Z", 2),
    ).toEqual(["2026-10-18T08:00:00.000Z", "2026-10-18T09:00:00.000Z"]);
  });

  it("cron reads day-of-month and day-of-week the usual way, either one matching", () => {
    // The 1st of the month, or any Monday.
    expect(
      runs(
        { kind: "cron", cron: "0 0 1 * 1" },
        "UTC",
        "2026-10-18T00:00:00Z",
        3,
      ),
    ).toEqual([
      "2026-10-19T00:00:00.000Z",
      "2026-10-26T00:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
    ]);
  });

  describe("across daylight saving", () => {
    const newYork = "America/New_York";

    it("keeps the wall-clock time when the offset changes: 09:00 in Los Angeles is an hour earlier in UTC after the spring change", () => {
      // The change is 2026-03-08 at 02:00 local.
      expect(
        runs(
          { kind: "daily", time: "09:00" },
          "America/Los_Angeles",
          "2026-03-07T00:00:00Z",
          3,
        ),
      ).toEqual([
        "2026-03-07T17:00:00.000Z",
        "2026-03-08T16:00:00.000Z",
        "2026-03-09T16:00:00.000Z",
      ]);
    });

    it("a time that does not exist that night runs once, after the gap, and the days after are unmoved", () => {
      // 02:30 never happens on 2026-03-08 in New York; the run is not lost, and it is not doubled.
      expect(
        runs(
          { kind: "daily", time: "02:30" },
          newYork,
          "2026-03-07T12:00:00Z",
          4,
        ),
      ).toEqual([
        "2026-03-08T07:30:00.000Z",
        "2026-03-09T06:30:00.000Z",
        "2026-03-10T06:30:00.000Z",
        "2026-03-11T06:30:00.000Z",
      ]);
    });

    it("a time that happens twice that night runs the first time round, once", () => {
      // 01:30 on 2026-11-01 is 05:30Z (EDT) and again 06:30Z (EST).
      expect(
        runs(
          { kind: "daily", time: "01:30" },
          newYork,
          "2026-10-31T12:00:00Z",
          3,
        ),
      ).toEqual([
        "2026-11-01T05:30:00.000Z",
        "2026-11-02T06:30:00.000Z",
        "2026-11-03T06:30:00.000Z",
      ]);
    });

    it("works the other way round in the southern hemisphere", () => {
      // Sydney moves its clocks forward on 2026-10-04.
      expect(
        runs(
          { kind: "daily", time: "09:00" },
          "Australia/Sydney",
          "2026-10-02T00:00:00Z",
          3,
        ),
      ).toEqual([
        "2026-10-02T23:00:00.000Z",
        "2026-10-03T22:00:00.000Z",
        "2026-10-04T22:00:00.000Z",
      ]);
    });

    it("hourly goes by the wall clock: the hour that happens twice is run once", () => {
      const times = runs(
        { kind: "hourly", every: 1 },
        newYork,
        "2026-11-01T04:00:00Z",
        4,
      );
      expect(times).toEqual([
        "2026-11-01T05:00:00.000Z",
        // 06:00Z is the second 01:00; the next one is 02:00 EST.
        "2026-11-01T07:00:00.000Z",
        "2026-11-01T08:00:00.000Z",
        "2026-11-01T09:00:00.000Z",
      ]);
    });
  });
});

describe("saying a schedule in words", () => {
  it("describes each shape", () => {
    expect(describeSchedule({ kind: "daily", time: "07:30" })).toBe(
      "every day at 07:30",
    );
    expect(
      describeSchedule({ kind: "weekly", days: [1, 3], time: "09:00" }),
    ).toBe("every Mon, Wed at 09:00");
    expect(describeSchedule({ kind: "hourly", every: 1 })).toBe("every hour");
    expect(describeSchedule({ kind: "hourly", every: 6 })).toBe(
      "every 6 hours",
    );
    expect(describeSchedule({ kind: "cron", cron: "0 9 * * 1-5" })).toBe(
      'cron "0 9 * * 1-5"',
    );
  });

  it("writes a moment as the zone's wall clock", () => {
    const moment = at("2026-10-18T01:30:00Z");
    expect(wallClock(moment, "Asia/Shanghai")).toBe("Sunday 2026-10-18 09:30");
    expect(wallClock(moment, "America/Los_Angeles")).toBe(
      "Saturday 2026-10-17 18:30",
    );
  });
});
