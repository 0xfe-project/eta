import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  describeScheduleFor,
  fullTime,
  localSchedule,
  nextRunState,
  occurrences,
  scheduleSetting,
} from "./routine-format";

const at = (iso: string) => new Date(iso);
const iso = (dates: Date[]) => dates.map((d) => d.toISOString());

describe("when a routine runs next", () => {
  it("reads the time in the routine's zone, not the browser's", () => {
    // 08:00 in Tokyo is 23:00 the day before in UTC.
    const times = occurrences(
      { kind: "daily", time: "08:00" },
      at("2026-10-09T00:00:00Z"),
      at("2026-10-11T00:00:00Z"),
      "Asia/Tokyo",
    );
    expect(iso(times)).toEqual([
      "2026-10-09T23:00:00.000Z",
      "2026-10-10T23:00:00.000Z",
    ]);
  });

  it("follows the zone's daylight saving changes", () => {
    // New York leaves daylight saving time on 2026-11-01.
    const times = occurrences(
      { kind: "daily", time: "08:00" },
      at("2026-10-31T00:00:00Z"),
      at("2026-11-03T00:00:00Z"),
      "America/New_York",
    );
    expect(iso(times)).toEqual([
      "2026-10-31T12:00:00.000Z",
      "2026-11-01T13:00:00.000Z",
      "2026-11-02T13:00:00.000Z",
    ]);
  });

  it("takes weekdays from the zone's calendar", () => {
    // Monday 07:00 in Shanghai is still Sunday in UTC.
    const times = occurrences(
      { kind: "weekly", days: [1], time: "07:00" },
      at("2026-10-10T00:00:00Z"),
      at("2026-10-20T00:00:00Z"),
      "Asia/Shanghai",
    );
    expect(iso(times)).toEqual([
      "2026-10-11T23:00:00.000Z",
      "2026-10-18T23:00:00.000Z",
    ]);
  });

  it("counts hours on the zone's clock", () => {
    // Every 6 hours in India (UTC+5:30): 00:00, 06:00, 12:00, 18:00 there.
    const times = occurrences(
      { kind: "hourly", every: 6 },
      at("2026-10-09T00:00:00Z"),
      at("2026-10-09T12:00:00Z"),
      "Asia/Kolkata",
    );
    expect(iso(times)).toEqual([
      "2026-10-09T00:30:00.000Z",
      "2026-10-09T06:30:00.000Z",
    ]);
  });

  it("leaves cron to the server", () => {
    const times = occurrences(
      { kind: "cron", cron: "0 8 * * *" },
      at("2026-10-09T00:00:00Z"),
      at("2026-10-12T00:00:00Z"),
      "UTC",
    );
    expect(times).toEqual([]);
  });
});

// Sunday 2026-11-15 20:00 in Shanghai; Berlin is on CET (UTC+1), seven hours behind.
const NOW = at("2026-11-15T12:00:00Z");
const BERLIN = "Europe/Berlin";
const SHANGHAI = "Asia/Shanghai";
const local = (schedule: Parameters<typeof localSchedule>[0], zone: string) =>
  describeSchedule(localSchedule(schedule, zone, SHANGHAI, NOW));

describe("a schedule on the viewer's clock", () => {
  it("is left as it is when the viewer is in the routine's zone", () => {
    const daily = { kind: "daily", time: "09:00" } as const;
    expect(localSchedule(daily, SHANGHAI, SHANGHAI, NOW)).toBe(daily);
    expect(local(daily, SHANGHAI)).toBe("每天 09:00");
    expect(describeScheduleFor(daily, SHANGHAI, SHANGHAI, NOW)).toBe(
      "每天 09:00",
    );
  });

  it("moves the time to the viewer's zone on the same day", () => {
    expect(local({ kind: "daily", time: "09:00" }, BERLIN)).toBe("每天 16:00");
    expect(local({ kind: "weekly", days: [1, 3], time: "09:00" }, BERLIN)).toBe(
      "每周一、三 16:00",
    );
  });

  it("moves the weekdays with it when the day changes", () => {
    // 20:00 Berlin is 03:00 the next day in Shanghai: Monday becomes Tuesday, Sunday Monday.
    expect(
      local({ kind: "weekly", days: [1, 3, 0], time: "20:00" }, BERLIN),
    ).toBe("每周一、二、四 03:00");
    // And back: Monday 06:00 in Shanghai is Sunday 23:00 in Berlin.
    expect(
      describeSchedule(
        localSchedule(
          { kind: "weekly", days: [1], time: "06:00" },
          SHANGHAI,
          BERLIN,
          NOW,
        ),
      ),
    ).toBe("每周日 23:00");
    // A daily time that crosses midnight is still daily.
    expect(local({ kind: "daily", time: "20:00" }, BERLIN)).toBe("每天 03:00");
  });

  it("leaves every N hours and cron alone", () => {
    const hourly = { kind: "hourly", every: 2 } as const;
    expect(localSchedule(hourly, BERLIN, SHANGHAI, NOW)).toBe(hourly);
    expect(describeScheduleFor(hourly, BERLIN, SHANGHAI, NOW)).toBe(
      "每 2 小时",
    );
    expect(scheduleSetting(hourly, BERLIN, SHANGHAI, NOW)).toBeNull();
    const cron = { kind: "cron", cron: "0 9 * * 1" } as const;
    expect(local(cron, BERLIN)).toBe("cron 0 9 * * 1");
    // Not converted, so the zone it is read in is said where it is shown.
    expect(describeScheduleFor(cron, BERLIN, SHANGHAI, NOW)).toBe(
      "cron 0 9 * * 1（按德国时间）",
    );
    expect(scheduleSetting(cron, BERLIN, SHANGHAI, NOW)).toBe(
      "cron 表达式按德国时间计算",
    );
  });

  it("names the original setting in brackets on the routine's page", () => {
    expect(
      describeScheduleFor(
        { kind: "daily", time: "09:00" },
        BERLIN,
        SHANGHAI,
        NOW,
      ),
    ).toBe("每天 16:00（德国时间 每天 09:00）");
  });
});

describe("the next run, bottom right of a row", () => {
  const routine = (fields: Partial<Parameters<typeof nextRunState>[0]>) => ({
    enabled: true,
    nextRunAt: null,
    runs: [],
    ...fields,
  });
  const state = (
    fields: Partial<Parameters<typeof nextRunState>[0]>,
    captainOn = true,
  ) => nextRunState(routine(fields), captainOn, NOW.getTime(), SHANGHAI).text;
  const later = (ms: number) => NOW.getTime() + ms;

  it("says how long until the next run", () => {
    expect(state({ nextRunAt: later(30 * 60_000) })).toBe("下次 · 30 分钟后");
    expect(state({ nextRunAt: later(20.5 * 3_600_000) })).toBe(
      "下次 · 20 小时后",
    );
    // Over a day away, but tomorrow on the calendar.
    expect(state({ nextRunAt: at("2026-11-16T15:30:00Z").getTime() })).toBe(
      "下次 · 明天",
    );
    expect(state({ nextRunAt: at("2026-11-18T08:00:00Z").getTime() })).toBe(
      "下次 · 3 天后",
    );
  });

  it("says a run is going, and for how long", () => {
    expect(
      state({
        nextRunAt: later(3_600_000),
        runs: [{ status: "running", startedAt: NOW.getTime() - 125_000 }],
      }),
    ).toBe("运行中 · 2 分钟");
  });

  it("says paused, Captain off, or never instead of a time", () => {
    expect(state({ enabled: false, nextRunAt: later(3_600_000) })).toBe(
      "已暂停",
    );
    // Nothing runs while Captain is off, so no time is promised.
    expect(state({ nextRunAt: later(3_600_000) }, false)).toBe(
      "Captain 已关闭",
    );
    expect(state({ nextRunAt: null })).toBe("不会再运行");
    expect(state({ nextRunAt: null }, false)).toBe("不会再运行");
  });
});

describe("the tooltip on the next run", () => {
  const next = at("2026-11-16T08:00:00Z").getTime();

  it("gives the full time on the viewer's clock", () => {
    expect(fullTime(next, SHANGHAI)).toBe("11-16 周一 16:00");
    expect(fullTime(next, BERLIN)).toBe("11-16 周一 09:00");
  });

  it("adds what the routine was set to only when its zone differs", () => {
    const daily = { kind: "daily", time: "09:00" } as const;
    expect(scheduleSetting(daily, SHANGHAI, SHANGHAI, NOW)).toBeNull();
    expect(scheduleSetting(daily, BERLIN, SHANGHAI, NOW)).toBe(
      "定时任务按德国时间 09:00 设定",
    );
    expect(
      scheduleSetting(
        { kind: "weekly", days: [3], time: "09:00" },
        BERLIN,
        SHANGHAI,
        NOW,
      ),
    ).toBe("定时任务按德国时间 每周三 09:00 设定");
  });
});
