import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as CTX } from "../../src/harness/context.ts";
import { nextCronAt, parseCron } from "../../src/harness/cron.ts";
import { LoopScheduler } from "../../src/harness/loops.ts";
import { createLoopTools, createScheduleTool, createSubagentTools } from "../../src/harness/tools/index.ts";
import {
	SubagentManager,
	type SubagentBus,
	type SubagentBusEvent,
	type SubagentUsage,
} from "../../src/harness/subagent.ts";

const NOOP = () => {};

const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);

describe("cron", () => {
	it("parses fields, steps, lists, ranges, names", () => {
		const schedule = parseCron("0 */15 9-17 * * MON-FRI");
		expect([...schedule.seconds.values]).toEqual([0]);
		expect([...schedule.minutes.values]).toEqual([0, 15, 30, 45]);
		expect([...schedule.hours.values]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
		expect([...schedule.daysOfWeek.values]).toEqual([1, 2, 3, 4, 5]);
		expect(() => parseCron("0 0 12 * *")).toThrow();
		expect(() => parseCron("0 0 70 * * *")).toThrow();
	});

	it("finds the next UTC match", () => {
		expect(nextCronAt(parseCron("0 30 9 * * *"), utc(2026, 3, 9, 9, 30))).toBe(utc(2026, 3, 9, 9, 30));
		expect(nextCronAt(parseCron("0 30 9 * * *"), utc(2026, 3, 9, 9, 31))).toBe(utc(2026, 3, 10, 9, 30));
		expect(nextCronAt(parseCron("0 0 0 1 JAN *"), utc(2026, 5, 2))).toBe(utc(2027, 1, 1));
		expect(nextCronAt(parseCron("*/20 * * * * *"), utc(2026, 1, 1, 0, 0, 5))).toBe(utc(2026, 1, 1, 0, 0, 20));
	});

	it("ORs dom with dow when both restricted", () => {
		const schedule = parseCron("0 0 0 13 * FRI");
		const first = nextCronAt(schedule, utc(2026, 2, 1));
		expect(first).toBe(utc(2026, 2, 6)); // first Friday, not the 13th
	});

	it("accepts 7 as Sunday", () => {
		expect([...parseCron("0 0 0 * * 7").daysOfWeek.values]).toEqual([0]);
	});
});

describe("loop cron scheduling", () => {
	it("fires when due and reschedules past the fired second", () => {
		const scheduler = new LoopScheduler({ followUpFor: (spec) => `go ${spec.def.id}` });
		const now = utc(2026, 3, 9, 9, 30);
		scheduler.upsert({
			def: { id: "nine", note: "standup", cron: "0 30 9 * * *" },
			runCount: 0,
			createdAt: now - 86_400_000,
			paused: false,
		});
		const fired = scheduler.pump(now);
		expect(fired.fired.map((f) => f.spec.def.id)).toEqual(["nine"]);
		expect(fired.fired[0]?.followUp).toBe("go nine");
		const spec = scheduler.list()[0]!;
		expect(spec.nextDueAt).toBe(utc(2026, 3, 10, 9, 30));
		expect(scheduler.pump(now + 60_000).fired.length).toBe(0);
	});
});

describe("loop / schedule / subagent tools", () => {
	it("LoopCreate, LoopList, LoopStop round-trip", async () => {
		const scheduler = new LoopScheduler({ followUpFor: (spec) => spec.def.note });
		const tools = createLoopTools(scheduler);
		await tools[0]!.execute(
			"t1",
			{ id: "ci", note: "check ci", every: "5m", expiresIn: "1d", maxRuns: 3 },
			NOOP,
			undefined,
			{} as never,
			CTX,
		);
		const listed = await tools[1]!.execute("t2", {}, NOOP, undefined, {} as never, CTX);
		expect((listed.content[0] as { text: string }).text).toContain("ci");
		await tools[2]!.execute("t3", { id: "ci" }, NOOP, undefined, {} as never, CTX);
		expect(scheduler.list().length).toBe(0);
		expect(() =>
			tools[0]!.execute("t4", { id: "bad", note: "n" }, NOOP, undefined, {} as never, CTX).then((r) => r.details),
		).not.toThrow();
	});

	it("Schedule fires exactly once", () => {
		const scheduler = new LoopScheduler({ followUpFor: (spec) => spec.def.note });
		const tools = createScheduleTool(scheduler);
		void tools[0]!.execute("s1", { note: "call mom", every: "10m" }, NOOP, undefined, {} as never, CTX);
		const spec = scheduler.list()[0]!;
		spec.nextDueAt = 1;
		expect(scheduler.pump(2).fired.length).toBe(1);
		expect(scheduler.pump(3).fired.length).toBe(0);
	});

	it("Agent / get_subagent_result / steer_subagent + RPC envelope", async () => {
		const listeners = new Map<SubagentBusEvent, Set<(p: Record<string, unknown>) => void>>();
		const bus: SubagentBus = {
			emit: (type, payload) => {
				for (const l of listeners.get(type) ?? []) l(payload);
			},
			on: (type, listener) => {
				const set = listeners.get(type) ?? new Set();
				listeners.set(type, set);
				set.add(listener);
				return () => set.delete(listener);
			},
		};
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let first = true;
		const manager = new SubagentManager(
			bus,
			async (record, api) => {
				if (first) {
					first = false;
					await gate;
					api.pendingNotes(record.id);
					return { input: 4, output: 2 };
				}
				return new Promise<SubagentUsage>(() => undefined);
			},
			4,
		);
		const stopServing = manager.serveRpc();
		const spawned = (await manager.rpc("spawn", { spec: { prompt: "dig" } })) as { id: string };
		expect(typeof spawned.id).toBe("string");
		const tools = createSubagentTools(manager);
		release!();
		await new Promise((r) => setTimeout(r, 0));
		const result = await manager.rpc("consume", { id: spawned.id });
		expect((result as { status: string }).status).toBe("done");
		const getResult = await tools[1]!.execute("g1", { id: spawned.id }, NOOP, undefined, {} as never, CTX);
		expect((getResult.content[0] as { text: string }).text).toContain("done");

		const live = await tools[0]!.execute("a1", { task: "run", background: true }, NOOP, undefined, {} as never, CTX);
		const liveId = (live.details as { record: { id: string } }).record.id;
		const steer = await tools[2]!.execute("st", { id: liveId, note: "careful" }, NOOP, undefined, {} as never, CTX);
		expect((steer.content[0] as { text: string }).text).toContain("Steered");
		expect(manager.pendingNotes(liveId)).toEqual(["careful"]);
		stopServing();
	});
});
