/** LoopCreate / LoopList / LoopStop / Schedule: the model's surface over the scheduler (C2). */

import { Type } from "typebox";
import type { Context } from "../context.ts";
import type { AgentHarnessTool } from "../types.ts";
import { parseEvery, type LoopScheduler } from "../loops.ts";
import { withId } from "./shared.ts";

let scheduleSequence = 0;

/** LoopCreate / LoopList / LoopStop: the model's surface over the C2 scheduler. */
export function createLoopTools(scheduler: LoopScheduler): AgentHarnessTool<object | undefined, any, any>[] {
	return [
		{
			name: "LoopCreate",
			label: "LoopCreate",
			description:
				"Schedule recurring notes to yourself: every ('45s'/'5m'/'2h'), or a 6-field cron (sec min hour dom mon dow, UTC). onEvent fires once per matching bus event. expiresIn caps lifetime ('2d').",
			parameters: Type.Object({
				id: Type.String({ description: "Stable name for this loop" }),
				note: Type.String({ description: "What to do each time it fires" }),
				every: Type.Optional(Type.String()),
				cron: Type.Optional(Type.String()),
				onEvent: Type.Optional(Type.String({ description: "Event type that fires this loop" })),
				maxRuns: Type.Optional(Type.Number()),
				expiresIn: Type.Optional(Type.String()),
			}),
			async execute(_id, { id, note, every, cron, onEvent, maxRuns, expiresIn }) {
				if (every === undefined && cron === undefined && onEvent === undefined)
					return withId("LoopCreate needs every, cron, or onEvent.", { error: true });
				const spec = {
					def: { id, note, ...(every !== undefined ? { every } : {}), ...(cron !== undefined ? { cron } : {}), ...(maxRuns !== undefined ? { maxRuns } : {}) },
					...(onEvent !== undefined ? { on: { type: onEvent } } : {}),
					...(expiresIn !== undefined ? { expiresAt: new Date(Date.now() + parseEvery(expiresIn)).toISOString() } : {}),
					runCount: 0,
					createdAt: Date.now(),
					paused: false,
				};
				scheduler.upsert(spec);
				return withId(`Loop ${id} scheduled.`, { spec });
			},
		},
		{
			name: "LoopList",
			label: "LoopList",
			description: "List scheduled loops with run counts and state.",
			parameters: Type.Object({}),
			async execute() {
				const rows = scheduler.list().map((spec) => `${spec.def.id}: ${spec.def.note} [${spec.paused ? "paused" : spec.def.cron ?? spec.def.every ?? "event"} x${spec.runCount}]`);
				return withId(rows.length === 0 ? "No loops." : rows.join("\n"), { count: rows.length });
			},
		},
		{
			name: "LoopStop",
			label: "LoopStop",
			description: "Remove a scheduled loop by id.",
			parameters: Type.Object({ id: Type.String() }),
			async execute(_id, { id }) {
				return withId(scheduler.remove(id) ? `Loop ${id} removed.` : `No loop ${id}.`, { removed: scheduler.list().length });
			},
		},
	];
}

/** One-shot Schedule tool: reuses C2 formats, fires exactly once. */
export function createScheduleTool(scheduler: LoopScheduler): AgentHarnessTool<object | undefined, any, any>[] {
	return [
		{
			name: "Schedule",
			label: "Schedule",
			description: "Remind yourself once: after every ('30m'), or at a 6-field cron time (next match fires once).",
			parameters: Type.Object({
				note: Type.String(),
				every: Type.Optional(Type.String()),
				cron: Type.Optional(Type.String()),
			}),
			async execute(_id, { note, every, cron }) {
				if (every === undefined && cron === undefined) return withId("Schedule needs every or cron.", { error: true });
				const id = `sched-${(++scheduleSequence).toString(36)}-${Date.now().toString(36)}`;
				const spec = {
					def: { id, note, ...(every !== undefined ? { every } : {}), ...(cron !== undefined ? { cron } : {}), maxRuns: 1 },
					runCount: 0,
					createdAt: Date.now(),
					paused: false,
				};
				scheduler.upsert(spec);
				return withId(`Scheduled ${id}.`, { spec });
			},
		},
	];
}
