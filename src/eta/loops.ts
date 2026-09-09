/**
 * Loop scheduler (C2). Semantics from pi-loop, architecture ours: no
 * event-sourced store, just a pure registry persisted as session KV values.
 *
 * The scheduler never times itself into action on its own: pump(now) is
 * called at run boundaries (and by an unref'd heartbeat), so an unattached
 * session never burns work. Every fire surfaces as a followUp driver at the
 * run boundary (S1), never as a mid-run interrupt.
 */

import type { LoopDef } from "./tasks.ts";

export interface LoopEvent {
	type: string;
	/** Flattened text used for substring / regex filters. */
	text?: string;
	payload?: Record<string, unknown>;
}

/** Extra scheduling fields carried alongside LoopDef in the registry value. */
export interface LoopSpec {
	def: LoopDef;
	/** Event trigger: fires when a bus event matches. */
	on?: { type: string; contains?: string; regex?: string; equals?: Record<string, unknown> };
	expiresAt?: string;
	/** Runtime bookkeeping; part of the persisted value. */
	runCount: number;
	nextDueAt?: number;
	createdAt: number;
	paused: boolean;
	disposed?: boolean;
}

const EVERY_PATTERN = /^(\d+)(ms|s|m|h|d)?$/;

/** Parse "45s" | "5m" | "2h" | "1d" | bare seconds into milliseconds. */
export function parseEvery(every: string): number {
	const match = EVERY_PATTERN.exec(every.trim().toLowerCase());
	if (match === null) throw new Error(`eta.loop: can't parse interval ${JSON.stringify(every)}`);
	const amount = Number(match[1]);
	const unitMs: Record<string, number> = {
		ms: 1,
		s: 1_000,
		m: 60_000,
		h: 3_600_000,
		d: 86_400_000,
	};
	return amount * (unitMs[match[2] ?? "s"] ?? 1_000);
}

/** Deterministic per-id jitter (0-10% of the interval) to avoid thundering herds. */
export function computeJitter(id: string, intervalMs: number): number {
	let hash = 2166136261;
	for (let i = 0; i < id.length; i++) {
		hash ^= id.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (Math.abs(hash) % (Math.floor(intervalMs * 0.1) + 1));
}

/** Default lifetime for loops without an explicit expiry (pi-loop parity). */
export const DEFAULT_LOOP_TTL_MS = 7 * 86_400_000;

/** True when a bus event should fire this loop. */
export function eventMatches(spec: LoopSpec, event: LoopEvent): boolean {
	const trigger = spec.on;
	if (trigger === undefined || trigger.type !== event.type) return false;
	if (trigger.contains !== undefined && !(event.text ?? "").includes(trigger.contains)) return false;
	if (trigger.regex !== undefined && !new RegExp(trigger.regex).test(event.text ?? "")) return false;
	if (trigger.equals !== undefined) {
		for (const [key, want] of Object.entries(trigger.equals)) {
			if (JSON.stringify(event.payload?.[key]) !== JSON.stringify(want)) return false;
		}
	}
	return true;
}

/** Trace depth cap for loop-fired continuations (old B9 runaway guard). */
export const MAX_TRACE_DEPTH = 8;

export interface PumpResult {
	fired: { spec: LoopSpec; followUp: string }[];
	disposed: string[];
	paused: string[];
}

export interface LoopSchedulerOptions {
	/** Turn a due loop into the followUp text handed to the run boundary. */
	followUpFor(spec: LoopSpec): string;
	/** Persist one registry value (session KV `eta.loop.state.<id>`). */
	persist?(spec: LoopSpec): void;
	/** Dev-stream emission (category "loop"). */
	dev?(category: string, action: string, data?: Record<string, unknown>): void;
}

export class LoopScheduler {
	private loops = new Map<string, LoopSpec>();
	/** Bumped whenever a session attaches so stale callbacks from the old session can't pump. */
	generation = 0;
	private readonly opts: LoopSchedulerOptions;

	constructor(opts: LoopSchedulerOptions) {
		this.opts = opts;
	}

	attach(): void {
		this.generation += 1;
	}

	upsert(spec: LoopSpec): void {
		this.loops.set(spec.def.id, spec);
		this.opts.persist?.(spec);
	}

	remove(id: string): boolean {
		return this.loops.delete(id);
	}

	pause(id: string, paused = true): void {
		const spec = this.loops.get(id);
		if (spec === undefined) return;
		spec.paused = paused;
		this.opts.persist?.(spec);
	}

	list(): LoopSpec[] {
		return [...this.loops.values()];
	}

	replay(specs: LoopSpec[]): void {
		for (const spec of specs) this.loops.set(spec.def.id, spec);
	}

	/** Feed one bus event; matching loops fire immediately (subject to caps). */
	public event(event: LoopEvent, traceDepth = 0): PumpResult {
		return this.collect(traceDepth, (spec) => eventMatches(spec, event));
	}

	/** Run-boundary tick: fires interval loops that are due and sweeps expiry. */
	public pump(now: number): PumpResult {
		const result = this.collect(0, (spec) => {
			if (spec.def.every === undefined || spec.paused) return false;
			const everyMs = parseEvery(spec.def.every);
			const dueAt = spec.nextDueAt ?? spec.createdAt + everyMs + computeJitter(spec.def.id, everyMs);
			return now >= dueAt;
		});
		for (const spec of this.loops.values()) {
			if (spec.paused || spec.disposed) continue;
			const expiresAt = spec.expiresAt ?? new Date(spec.createdAt + DEFAULT_LOOP_TTL_MS).toISOString();
			if (Date.parse(expiresAt) <= now) {
				spec.disposed = true;
				result.disposed.push(spec.def.id);
				this.loops.delete(spec.def.id);
				this.opts.persist?.(spec);
				this.opts.dev?.("loop", "expired", { id: spec.def.id });
			}
		}
		for (const fired of result.fired) {
			const spec = this.loops.get(fired.spec.def.id);
			if (spec?.def.every !== undefined) {
				spec.nextDueAt = now + parseEvery(spec.def.every) + computeJitter(spec.def.id, parseEvery(spec.def.every));
				this.opts.persist?.(spec);
			}
		}
		return result;
	}

	private collect(traceDepth: number, due: (spec: LoopSpec) => boolean): PumpResult {
		const fired: PumpResult["fired"] = [];
		const paused: string[] = [];
		const disposed: string[] = [];
		for (const spec of this.loops.values()) {
			if (spec.paused || spec.disposed) continue;
			if (!due(spec)) continue;
			if (traceDepth > MAX_TRACE_DEPTH) {
				this.opts.dev?.("loop", "suppressed", { id: spec.def.id, reason: "trace_depth" });
				continue;
			}
			spec.runCount += 1;
			fired.push({ spec, followUp: this.opts.followUpFor(spec) });
			this.opts.dev?.("loop", "fired", { id: spec.def.id, runCount: spec.runCount });
			if (spec.def.maxRuns !== undefined && spec.runCount >= spec.def.maxRuns) {
				spec.paused = true;
				paused.push(spec.def.id);
				this.opts.dev?.("loop", "paused", { id: spec.def.id, reason: "max_runs" });
			}
			this.opts.persist?.(spec);
		}
		return { fired, disposed, paused };
	}
}
