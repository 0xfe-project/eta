/**
 * Loop scheduler (C2). Semantics from pi-loop, architecture ours: no
 * event-sourced store, just a pure registry persisted as session KV values.
 *
 * The scheduler never times itself into action on its own: pump(now) is
 * called at run boundaries, and by a heartbeat that exists only while the
 * registry is non-empty. Whoever pumps owns the `fired` list: at a run
 * boundary the followUp goes back into the run, from the heartbeat it must
 * wake the session (S1) — a fire nobody consumes would only burn the count.
 * Every fire surfaces as a followUp, never as a mid-run interrupt.
 */

import { nextCronAt, parseCron } from "./cron.ts";
import type { LoopDef, LoopSpec } from "./session/types.ts";

export type { LoopDef, LoopSpec } from "./session/types.ts";

export interface LoopEvent {
	type: string;
	/** Flattened text used for substring / regex filters. */
	text?: string;
	payload?: Record<string, unknown>;
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
	return Math.abs(hash) % (Math.floor(intervalMs * 0.1) + 1);
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
	/** Observation emission on the main bus (category "loop"). */
	observe?(category: string, action: string, data?: Record<string, unknown>): void;
	/**
	 * Registry size moved. The heartbeat listens: `0` means there is nothing left
	 * to wake for and the timer should not exist, so an idle session with no loops
	 * holds no timer at all, and the first loop created gets one without a restart.
	 */
	onRegistryChange?(count: number): void;
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
		const created = !this.loops.has(spec.def.id);
		this.arm(spec);
		this.loops.set(spec.def.id, spec);
		this.opts.persist?.(spec);
		// Created/updated is a state change the GUI shows and the projector must see:
		// loops live outside the journal, so without this emission the view frame that
		// follows a create still carries the registry from before it.
		this.opts.observe?.("loop", created ? "created" : "updated", { id: spec.def.id });
		this.changed();
	}

	remove(id: string): boolean {
		const spec = this.loops.get(id);
		if (spec === undefined) return false;
		spec.disposed = true;
		this.loops.delete(id);
		this.opts.persist?.(spec);
		this.opts.observe?.("loop", "removed", { id });
		this.changed();
		return true;
	}

	pause(id: string, paused = true): void {
		const spec = this.loops.get(id);
		if (spec === undefined) return;
		spec.paused = paused;
		this.opts.persist?.(spec);
		this.opts.observe?.("loop", paused ? "paused" : "resumed", { id });
		// The registry did not change size, but what it is waiting for did: a paused loop
		// has no next wake, a resumed one has a new one.
		this.changed();
	}

	list(): LoopSpec[] {
		return [...this.loops.values()];
	}

	/**
	 * Load a persisted registry after a restart. Deliberately not `upsert`: a replay
	 * is not a state change, and re-emitting or re-persisting one entry per loop on
	 * every reopen would fill the journal with the same news every time.
	 */
	replay(specs: LoopSpec[]): void {
		for (const spec of specs) {
			this.arm(spec);
			this.loops.set(spec.def.id, spec);
		}
		this.changed();
	}

	/**
	 * When a schedule-triggered spec is next due, worked out at once. An interval loop
	 * that leaves this blank until its first fire cannot tell the panel when it will go
	 * off, which is the first thing somebody asks after creating it.
	 */
	private arm(spec: LoopSpec): void {
		if (spec.nextDueAt !== undefined) return; // a restored loop keeps the due time it was saved with
		if (spec.def.cron !== undefined) spec.nextDueAt = nextCronAt(parseCron(spec.def.cron), spec.createdAt);
		else if (spec.def.every !== undefined)
			spec.nextDueAt = spec.createdAt + parseEvery(spec.def.every) + computeJitter(spec.def.id, parseEvery(spec.def.every));
	}

	/** When a spec with a schedule trigger next becomes due, or undefined for an event-only one. */
	private wakeTimeOf(spec: LoopSpec, now: number): number | undefined {
		if (spec.nextDueAt !== undefined) return spec.nextDueAt;
		if (spec.def.cron !== undefined) return nextCronAt(parseCron(spec.def.cron), now);
		if (spec.def.every !== undefined) {
			const everyMs = parseEvery(spec.def.every);
			return spec.createdAt + everyMs + computeJitter(spec.def.id, everyMs);
		}
		return undefined;
	}

	/**
	 * The earliest moment a `pump` could fire anything, or `undefined` when no loop has a
	 * schedule to wait for. Whoever keeps a timer alive needs this: a fixed cadence is
	 * silent for the whole of one cadence after a short loop comes due, which is exactly
	 * when a `5s` loop was supposed to say something.
	 */
	nextWakeAt(now = Date.now()): number | undefined {
		let earliest: number | undefined;
		for (const spec of this.loops.values()) {
			if (spec.paused || spec.disposed) continue;
			const at = this.wakeTimeOf(spec, now);
			if (at === undefined) continue;
			if (earliest === undefined || at < earliest) earliest = at;
		}
		return earliest;
	}

	private changed(): void {
		this.opts.onRegistryChange?.(this.loops.size);
	}

	/** FollowUps from loops that fired when the consumer could not take them all. */
	private deferred: string[] = [];

	/** Hand back followUps that fired but found no slot; the next boundary delivers them. */
	defer(followUps: string[]): void {
		this.deferred.push(...followUps);
	}

	/**
	 * Take the oldest undelivered followUp. One per run boundary keeps a burst of
	 * loops from arriving as one giant prompt; the rest wait for the next boundary
	 * with their runCount already paid for.
	 */
	takeDeferred(): string | undefined {
		return this.deferred.shift();
	}

	/** Feed one bus event; matching loops fire immediately (subject to caps). */
	public event(event: LoopEvent, traceDepth = 0): PumpResult {
		return this.collect(traceDepth, (spec) => eventMatches(spec, event));
	}

	/** Run-boundary tick: fires interval loops that are due and sweeps expiry. */
	public pump(now: number): PumpResult {
		const result = this.collect(0, (spec) => {
			if (spec.paused) return false;
			if (spec.def.cron !== undefined) {
				const dueAt = spec.nextDueAt ?? nextCronAt(parseCron(spec.def.cron), now);
				spec.nextDueAt = dueAt;
				return now >= dueAt;
			}
			if (spec.def.every === undefined) return false;
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
				this.opts.observe?.("loop", "expired", { id: spec.def.id });
			}
		}
		if (result.disposed.length > 0) this.changed();
		for (const fired of result.fired) {
			const spec = this.loops.get(fired.spec.def.id);
			if (spec === undefined) continue;
			if (spec.def.cron !== undefined) {
				spec.nextDueAt = nextCronAt(parseCron(spec.def.cron), now + 1_000);
				this.opts.persist?.(spec);
			} else if (spec.def.every !== undefined) {
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
				this.opts.observe?.("loop", "suppressed", { id: spec.def.id, reason: "trace_depth" });
				continue;
			}
			spec.runCount += 1;
			fired.push({ spec, followUp: this.opts.followUpFor(spec) });
			this.opts.observe?.("loop", "fired", { id: spec.def.id, runCount: spec.runCount });
			if (spec.def.maxRuns !== undefined && spec.runCount >= spec.def.maxRuns) {
				spec.paused = true;
				paused.push(spec.def.id);
				this.opts.observe?.("loop", "paused", { id: spec.def.id, reason: "max_runs" });
			}
			this.opts.persist?.(spec);
		}
		return { fired, disposed, paused };
	}
}
