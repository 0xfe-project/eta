/**
 * Six-field cron (sec min hour dom mon dow), UTC — the format pi-loop used.
 * Supports `*`, numbers, ranges, lists, steps, month/day names. dom and dow
 * both restricted means OR, matching classic Vixie cron. Matching is done by
 * scanning candidate days, so anything with a period under five years is exact.
 */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface CronField {
	values: ReadonlySet<number>;
	restricted: boolean;
}

export interface CronSchedule {
	seconds: CronField;
	minutes: CronField;
	hours: CronField;
	daysOfMonth: CronField;
	months: CronField;
	daysOfWeek: CronField;
}

interface FieldSpec {
	min: number;
	max: number;
	names?: string[];
	nameOffset?: number;
	wrap?: boolean;
}

function expandToken(token: string, spec: FieldSpec, out: Set<number>): void {
	let step = 1;
	let body = token;
	const slash = body.indexOf("/");
	if (slash >= 0) {
		step = Number(body.slice(slash + 1));
		body = body.slice(0, slash);
		if (!Number.isInteger(step) || step <= 0) throw new Error(`eta.cron: bad step in ${JSON.stringify(token)}`);
	}
	const resolve = (raw: string): number => {
		const lowered = raw.toLowerCase();
		if (spec.names !== undefined) {
			const at = spec.names.indexOf(lowered);
			if (at >= 0) return at + (spec.nameOffset ?? 0);
		}
		const n = Number(lowered);
		if (!Number.isInteger(n)) throw new Error(`eta.cron: bad token ${JSON.stringify(raw)}`);
		return spec.wrap && n === spec.max + 1 ? 0 : n;
	};
	let lo: number;
	let hi: number;
	if (body === "*") {
		lo = spec.min;
		hi = spec.max;
	} else if (body.includes("-")) {
		const [a, b] = body.split("-") as [string, string];
		lo = resolve(a);
		hi = resolve(b);
	} else {
		lo = resolve(body);
		hi = step > 1 ? spec.max : lo;
	}
	if (lo < spec.min || hi > spec.max || lo > hi) throw new Error(`eta.cron: ${JSON.stringify(token)} out of range`);
	for (let v = lo; v <= hi; v += step) out.add(v);
}

function parseField(raw: string, spec: FieldSpec): CronField {
	const values = new Set<number>();
	const restricted = raw.trim() !== "*" && !/^\*\/\d+$/.test(raw.trim());
	for (const token of raw.split(",")) expandToken(token.trim(), spec, values);
	if (values.size === 0) throw new Error(`eta.cron: empty field ${JSON.stringify(raw)}`);
	for (const v of values) {
		if (v < spec.min || v > spec.max) throw new Error(`eta.cron: ${JSON.stringify(raw)} out of range`);
	}
	return { values, restricted };
}

export function parseCron(expression: string): CronSchedule {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 6) throw new Error(`eta.cron: need 6 fields (sec min hour dom mon dow), got ${JSON.stringify(expression)}`);
	const [seconds, minutes, hours, dom, mon, dow] = parts as [string, string, string, string, string, string];
	return {
		seconds: parseField(seconds, { min: 0, max: 59 }),
		minutes: parseField(minutes, { min: 0, max: 59 }),
		hours: parseField(hours, { min: 0, max: 23 }),
		daysOfMonth: parseField(dom, { min: 1, max: 31 }),
		months: parseField(mon, { min: 1, max: 12, names: MONTHS, nameOffset: 1 }),
		daysOfWeek: parseField(dow, { min: 0, max: 6, names: DAYS, wrap: true }),
	};
}

function sorted(values: ReadonlySet<number>): number[] {
	return [...values].sort((a, b) => a - b);
}

/** First instant at or after `fromMs` matching the schedule (UTC, <5 years out). */
export function nextCronAt(schedule: CronSchedule, fromMs: number): number {
	const sec = sorted(schedule.seconds.values);
	const min = sorted(schedule.minutes.values);
	const hr = sorted(schedule.hours.values);
	const domOrDow = schedule.daysOfMonth.restricted && schedule.daysOfWeek.restricted;
	const day = new Date(Math.floor(fromMs / 1000) * 1000);
	day.setUTCSeconds(0, 0);
	for (let scanned = 0; scanned < 366 * 5; scanned++) {
		const month = day.getUTCMonth() + 1;
		const matchesMonth = schedule.months.values.has(month);
		const domOk = schedule.daysOfMonth.values.has(day.getUTCDate());
		const dowOk = schedule.daysOfWeek.values.has(day.getUTCDay());
		const dayOk = matchesMonth && (domOrDow ? domOk || dowOk : domOk && dowOk);
		if (dayOk) {
			for (const h of hr) {
				for (const m of min) {
					for (const s of sec) {
						const at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m, s);
						if (at >= fromMs) return at;
					}
				}
			}
		}
		day.setUTCDate(day.getUTCDate() + 1);
	}
	throw new Error("eta.cron: no matching time within five years");
}
