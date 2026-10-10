import { describe, expect, it } from "@rstest/core";
import { occurrences } from "./routine-format";

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
