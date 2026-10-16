/**
 * When a routine runs next (REFACTOR.md §9, P3.3).
 *
 * The four shapes the browser offers have to become one cron, and that cron has to be evaluated in
 * the routine's own zone — including across a daylight-saving change, which is where a naive
 * implementation is wrong by an hour twice a year. Both halves are checked here: the translation,
 * the matching, and the two instants that are famously easy to get wrong.
 */
import { describe, expect, it } from "vitest";
import {
	cronOf,
	InvalidSchedule,
	isValidTimeZone,
	nextRun,
	validateSchedule,
} from "../src/routines/schedule";

/** A UTC instant, for readable expectations. */
const at = (iso: string): Date => new Date(iso);

describe("the browser's shapes become cron", () => {
	it("translates each kind, and refuses what is not a schedule", () => {
		expect(cronOf({ kind: "daily", time: "07:30" })).toBe("30 7 * * *");
		// `cronOf` renders what it is given; sorting and de-duplicating is the validator's job, so a
		// stored schedule is already tidy and this stays a pure translation.
		expect(cronOf({ kind: "weekly", days: [1, 3], time: "09:05" })).toBe("5 9 * * 1,3");
		expect(cronOf({ kind: "hourly", every: 4 })).toBe("0 */4 * * *");
		expect(cronOf({ kind: "cron", cron: "0 9 * * 1-5" })).toBe("0 9 * * 1-5");

		expect(validateSchedule({ kind: "daily", time: "07:30" })).toEqual({
			kind: "daily",
			time: "07:30",
		});
		expect(validateSchedule({ kind: "weekly", days: [1, 1, 5], time: "09:05" })).toEqual({
			kind: "weekly",
			days: [1, 5],
			time: "09:05",
		});
		expect(validateSchedule({ kind: "hourly", every: 6 })).toEqual({ kind: "hourly", every: 6 });
	});

	it("refuses the shapes a scheduler cannot run", () => {
		const bad: unknown[] = [
			{ kind: "daily", time: "7:30" },
			{ kind: "daily", time: "25:00" },
			{ kind: "weekly", days: [], time: "07:30" },
			{ kind: "weekly", days: [7], time: "07:30" },
			{ kind: "hourly", every: 5 },
			{ kind: "cron", cron: "0 9 * *" },
			{ kind: "cron", cron: "0 25 * * *" },
			{ kind: "cron", cron: "61 9 * * *" },
			{ kind: "sometimes" },
			null,
		];
		for (const schedule of bad) {
			expect(() => validateSchedule(schedule), JSON.stringify(schedule)).toThrow(
				InvalidSchedule,
			);
		}
	});
});

describe("when it runs next", () => {
	it("finds the next minute for a daily time, in the routine's zone", () => {
		// 07:30 in Shanghai is 23:30 UTC the day before.
		const next = nextRun({ kind: "daily", time: "07:30" }, "Asia/Shanghai", at("2026-10-16T00:00:00Z"));
		expect(next?.toISOString()).toBe("2026-10-16T23:30:00.000Z");

		// Already past it today: tomorrow.
		const later = nextRun(
			{ kind: "daily", time: "07:30" },
			"Asia/Shanghai",
			at("2026-10-16T23:31:00Z"),
		);
		expect(later?.toISOString()).toBe("2026-10-17T23:30:00.000Z");

		// The same wall time in another zone is another instant.
		const utc = nextRun({ kind: "daily", time: "07:30" }, "UTC", at("2026-10-16T00:00:00Z"));
		expect(utc?.toISOString()).toBe("2026-10-16T07:30:00.000Z");
	});

	it("walks a weekly schedule to the right weekday", () => {
		// 2026-10-16 is a Friday. Mondays at 09:00 in UTC.
		const next = nextRun({ kind: "weekly", days: [1], time: "09:00" }, "UTC", at("2026-10-16T12:00:00Z"));
		expect(next?.toISOString()).toBe("2026-10-19T09:00:00.000Z");
	});

	it("steps hourly from the hour it is in", () => {
		const next = nextRun({ kind: "hourly", every: 6 }, "UTC", at("2026-10-16T07:10:00Z"));
		expect(next?.toISOString()).toBe("2026-10-16T12:00:00.000Z");
	});

	it("keeps the wall time across a daylight-saving change", () => {
		// Europe/Berlin moves to CEST on 2026-03-29 at 02:00 local. 07:30 is 06:30 UTC before and
		// 05:30 UTC after — a schedule that stores an offset would be an hour off here.
		const before = nextRun({ kind: "daily", time: "07:30" }, "Europe/Berlin", at("2026-03-28T00:00:00Z"));
		expect(before?.toISOString()).toBe("2026-03-28T06:30:00.000Z");
		const after = nextRun({ kind: "daily", time: "07:30" }, "Europe/Berlin", at("2026-03-29T00:00:00Z"));
		expect(after?.toISOString()).toBe("2026-03-29T05:30:00.000Z");
		// And the wall clock it lands on really is 07:30 there.
		const wall = new Intl.DateTimeFormat("en-GB", {
			timeZone: "Europe/Berlin",
			hour: "2-digit",
			minute: "2-digit",
		}).format(after!);
		expect(wall).toBe("07:30");
	});

	it("does not fire twice for the minute it is already in", () => {
		// A run due at 07:30 that is being scheduled at 07:30 exactly waits for tomorrow.
		const next = nextRun({ kind: "daily", time: "07:30" }, "UTC", at("2026-10-16T07:30:00Z"));
		expect(next?.toISOString()).toBe("2026-10-17T07:30:00.000Z");
	});

	it("gives up on a schedule that never happens rather than searching forever", () => {
		// February 30th: a valid cron expression, an impossible date.
		expect(nextRun({ kind: "cron", cron: "0 9 30 2 *" }, "UTC", at("2026-10-16T00:00:00Z"))).toBeUndefined();
	});

	it("refuses a zone it does not know", () => {
		expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
		expect(isValidTimeZone("Mars/Olympus")).toBe(false);
		expect(() =>
			nextRun({ kind: "daily", time: "07:30" }, "Mars/Olympus", at("2026-10-16T00:00:00Z")),
		).toThrow(InvalidSchedule);
	});
});
