/**
 * When a routine runs (REFACTOR.md §9, P3.3).
 *
 * The browser offers four shapes and the scheduler needs one: five-field cron. This module is the
 * translation, and it is where "when does it run next" is answered — the same expression the
 * scheduler fires on, evaluated in the routine's own time zone.
 *
 * Written here rather than taken from a library because the whole of what is needed is small: the
 * fields, a matcher, and the arithmetic that turns a wall-clock time in a zone into an instant. The
 * time zone half uses `Intl`, which the runtime already has; the rest is set membership.
 */

export interface DailySchedule {
	kind: "daily";
	/** `HH:MM` in the routine's zone. */
	time: string;
}

export interface WeeklySchedule {
	kind: "weekly";
	/** 0 is Sunday, as in cron. */
	days: number[];
	time: string;
}

export interface HourlySchedule {
	kind: "hourly";
	every: number;
}

export interface CronSchedule {
	kind: "cron";
	/** Five fields: minute hour day-of-month month day-of-week. */
	cron: string;
}

export type Schedule =
	| DailySchedule
	| WeeklySchedule
	| HourlySchedule
	| CronSchedule;

/** The hours an `hourly` routine may step by; anything else is not a schedule, it is a typo. */
export const HOURLY_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;

export class InvalidSchedule extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidSchedule";
	}
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Check a schedule says something a scheduler can run, or say why not. */
export function validateSchedule(schedule: unknown): Schedule {
	if (typeof schedule !== "object" || schedule === null) {
		throw new InvalidSchedule("计划必须是一个对象。");
	}
	const value = schedule as Record<string, unknown>;
	const kind = value.kind;
	if (kind === "daily") {
		const time = typeof value.time === "string" ? value.time : "";
		if (!TIME.test(time)) throw new InvalidSchedule("每天的计划需要 HH:MM 的时间。");
		return { kind: "daily", time };
	}
	if (kind === "weekly") {
		const time = typeof value.time === "string" ? value.time : "";
		if (!TIME.test(time)) throw new InvalidSchedule("每周的计划需要 HH:MM 的时间。");
		const days = Array.isArray(value.days) ? value.days : [];
		if (
			days.length === 0 ||
			days.some((day) => !Number.isInteger(day) || (day as number) < 0 || (day as number) > 6)
		) {
			throw new InvalidSchedule("每周的计划需要 1–7 个 0–6 的星期(0 是周日)。");
		}
		return { kind: "weekly", days: [...new Set(days as number[])].sort(), time };
	}
	if (kind === "hourly") {
		const every = value.every;
		if (!HOURLY_STEPS.includes(every as (typeof HOURLY_STEPS)[number])) {
			throw new InvalidSchedule(`每小时的间隔只能是 ${HOURLY_STEPS.join("、")}。`);
		}
		return { kind: "hourly", every: every as number };
	}
	if (kind === "cron") {
		const cron = typeof value.cron === "string" ? value.cron.trim() : "";
		parseCron(cron);
		return { kind: "cron", cron };
	}
	throw new InvalidSchedule("计划只能是 daily、weekly、hourly 或 cron。");
}

/** The schedule as five-field cron: what the scheduler fires on and the page counts down to. */
export function cronOf(schedule: Schedule): string {
	switch (schedule.kind) {
		case "cron":
			return schedule.cron;
		case "hourly":
			return `0 */${schedule.every} * * *`;
		case "daily": {
			const [hour, minute] = schedule.time.split(":");
			return `${Number(minute)} ${Number(hour)} * * *`;
		}
		case "weekly": {
			const [hour, minute] = schedule.time.split(":");
			return `${Number(minute)} ${Number(hour)} * * ${schedule.days.join(",")}`;
		}
	}
}

/** One cron field: the set of numbers it allows. */
interface Field {
	values: Set<number>;
	/** Whether the field was unrestricted (`*`, or a step from it): the day rule turns on this. */
	any: boolean;
}

interface FieldSpec {
	name: string;
	min: number;
	max: number;
}

const FIELDS: readonly FieldSpec[] = [
	{ name: "分钟", min: 0, max: 59 },
	{ name: "小时", min: 0, max: 23 },
	{ name: "日", min: 1, max: 31 },
	{ name: "月", min: 1, max: 12 },
	{ name: "星期", min: 0, max: 6 },
];

function parseField(raw: string, spec: FieldSpec): Field {
	const values = new Set<number>();
	const any = raw === "*" || raw.startsWith("*/");
	for (const part of raw.split(",")) {
		const [range, stepRaw] = part.split("/");
		const step = stepRaw === undefined ? 1 : Number(stepRaw);
		if (!Number.isInteger(step) || step < 1) {
			throw new InvalidSchedule(`${spec.name}的步长无效：${part}`);
		}
		let from = spec.min;
		let to = spec.max;
		if (range !== "*" && range !== undefined) {
			const [startRaw, endRaw] = range.split("-");
			const start = Number(startRaw);
			if (!Number.isInteger(start) || start < spec.min || start > spec.max) {
				throw new InvalidSchedule(`${spec.name}超出范围：${range}`);
			}
			from = start;
			to = endRaw === undefined ? start : Number(endRaw);
			if (!Number.isInteger(to) || to < spec.min || to > spec.max || to < from) {
				throw new InvalidSchedule(`${spec.name}超出范围：${range}`);
			}
		}
		for (let value = from; value <= to; value += step) values.add(value);
	}
	if (values.size === 0) throw new InvalidSchedule(`${spec.name}没有任何取值：${raw}`);
	return { values, any };
}

interface Cron {
	minute: Field;
	hour: Field;
	dayOfMonth: Field;
	month: Field;
	dayOfWeek: Field;
}

const cache = new Map<string, Cron>();

/** Parse and cache a five-field cron; a bad expression is refused with which field is bad. */
export function parseCron(expression: string): Cron {
	const cached = cache.get(expression);
	if (cached !== undefined) return cached;
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new InvalidSchedule("cron 需要 5 段：分钟 小时 日 月 星期。");
	}
	const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((raw, index) =>
		parseField(raw!, FIELDS[index]!),
	) as [Field, Field, Field, Field, Field];
	const cron: Cron = { minute, hour, dayOfMonth, month, dayOfWeek };
	cache.set(expression, cron);
	return cron;
}

/** Whether a wall-clock moment matches. `dayOfWeek` is 0 for Sunday. */
function matches(cron: Cron, at: WallClock): boolean {
	if (!cron.minute.values.has(at.minute)) return false;
	if (!cron.hour.values.has(at.hour)) return false;
	if (!cron.month.values.has(at.month)) return false;
	// The standard rule: when both day fields are restricted, either may match.
	const dayOfMonth = cron.dayOfMonth.values.has(at.day);
	const dayOfWeek = cron.dayOfWeek.values.has(at.weekday);
	if (cron.dayOfMonth.any && cron.dayOfWeek.any) return true;
	if (cron.dayOfMonth.any) return dayOfWeek;
	if (cron.dayOfWeek.any) return dayOfMonth;
	return dayOfMonth || dayOfWeek;
}

/** A moment as a clock on a wall: what a cron expression is written against. */
interface WallClock {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	/** 0 is Sunday. */
	weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The wall clock in a zone, using `Intl` (the runtime's own zone database). */
function wallClockAt(instant: Date, timeZone: string): WallClock {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
		weekday: "short",
	}).formatToParts(instant);
	const value = (type: string): string =>
		parts.find((part) => part.type === type)?.value ?? "0";
	const hour = Number(value("hour")) % 24;
	return {
		year: Number(value("year")),
		month: Number(value("month")),
		day: Number(value("day")),
		hour,
		minute: Number(value("minute")),
		weekday: Math.max(0, WEEKDAYS.indexOf(value("weekday") as (typeof WEEKDAYS)[number])),
	};
}

/** Whether a zone is one this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
	if (timeZone.length === 0) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return false;
	}
}

/**
 * The instant a wall-clock time in a zone happens.
 *
 * The zone's offset is not a constant (it is the whole point of a zone), so the answer is found by
 * guessing with the offset at the naive instant and correcting once — the standard trick. Across a
 * spring-forward gap the wall time does not exist; the correction lands after it, which is what a
 * person expects of "07:30 daily" on the day the clock jumps.
 */
function instantOf(wall: WallClock, timeZone: string): Date {
	const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
	const first = new Date(naive - offsetAt(new Date(naive), timeZone));
	return new Date(naive - offsetAt(first, timeZone));
}

/**
 * How far ahead of UTC a zone is at an instant, in milliseconds.
 *
 * The wall clock in that zone, read as if it were UTC, minus the instant itself — truncated to the
 * minute, because a wall clock has no seconds to compare.
 */
function offsetAt(instant: Date, timeZone: string): number {
	const wall = wallClockAt(instant, timeZone);
	const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
	const truncated = instant.getTime() - (instant.getTime() % 60_000);
	return asUtc - truncated;
}

/** How far ahead of a wall clock the search may go before giving up (a leap-day cron is rare). */
const MAX_MINUTES = 366 * 24 * 60 * 4;

/**
 * When the routine runs next, after `from`.
 *
 * The search walks the *wall clock* minute by minute — cheap, because the clock is arithmetic —
 * and converts only the answer. A cron that never matches (February 30th) is refused rather than
 * searched forever.
 */
export function nextRun(
	schedule: Schedule,
	timeZone: string,
	from: Date = new Date(),
): Date | undefined {
	if (!isValidTimeZone(timeZone)) {
		throw new InvalidSchedule(`无效的时区：${timeZone}`);
	}
	const cron = parseCron(cronOf(schedule));
	const start = wallClockAt(from, timeZone);
	// The next minute, so a run that is due this minute is not scheduled again immediately.
	let wall: WallClock = { ...start };
	const step = (): void => {
		wall = { ...wall, minute: wall.minute + 1 };
		if (wall.minute > 59) {
			wall.minute = 0;
			wall.hour += 1;
		}
		if (wall.hour > 23) {
			wall.hour = 0;
			wall.day += 1;
			wall.weekday = (wall.weekday + 1) % 7;
			const days = new Date(Date.UTC(wall.year, wall.month, 0)).getUTCDate();
			if (wall.day > days) {
				wall.day = 1;
				wall.month += 1;
				if (wall.month > 12) {
					wall.month = 1;
					wall.year += 1;
				}
			}
		}
	};
	step();
	for (let index = 0; index < MAX_MINUTES; index++) {
		if (matches(cron, wall)) return instantOf(wall, timeZone);
		step();
	}
	return undefined;
}
