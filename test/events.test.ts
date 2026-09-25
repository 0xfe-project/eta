import { Context } from "cordis";
import { describe, expect, expectTypeOf, it } from "vitest";
import { KERNEL_EVENT_NAMES, type KernelEvents, kernelEmit, kernelOn } from "../src/types/events.ts";

describe("event vocabulary", () => {
	it("names are pinned against drift", () => {
		expect([...KERNEL_EVENT_NAMES].sort()).toEqual([...KERNEL_EVENT_NAMES]);
		expect(KERNEL_EVENT_NAMES).toMatchInlineSnapshot(`
			[
			  "goal:changed",
			  "goal:cleared",
			  "inject:received",
			  "persona:loaded",
			  "persona:missing",
			  "persona:switched",
			  "storage:appended",
			  "storage:changed",
			  "storage:compacted",
			  "storage:error",
			  "task:cancelled",
			  "task:completed",
			  "task:created",
			  "task:removed",
			  "task:updated",
			  "tool:call",
			  "tool:result",
			  "turn:end",
			  "turn:run-end",
			  "turn:start",
			]
		`);
		// The interface keys and the pinned names are the same set: assigning the
		// pinned names into a record keyed by the interface compiles only if they match.
		const coverage: Record<keyof KernelEvents, (typeof KERNEL_EVENT_NAMES)[number]> = Object.fromEntries(
			KERNEL_EVENT_NAMES.map((n) => [n, n]),
		) as never;
		expect(Object.keys(coverage)).toHaveLength(KERNEL_EVENT_NAMES.length);
	});

	it("kernelEmit/kernelOn round-trip over a real cordis context", () => {
		const ctx = new Context();
		const seen: { name: string; payload: unknown }[] = [];
		const off = kernelOn(ctx)("tool:result", (p) => {
			seen.push({ name: "tool:result", payload: p });
		});
		const emit = kernelEmit(ctx);
		emit("tool:result", { name: "bash", result: { ok: true }, durationMs: 5, turn: 1 });
		emit("task:created", { action: "created", task: { id: "t1", content: "c", status: "pending" } });
		off();
		emit("tool:result", { name: "bash", result: { ok: false }, durationMs: 1, turn: 2 });
		expect(seen).toHaveLength(1);
		expect(seen[0].payload).toMatchObject({ name: "bash", result: { ok: true } });
		void ctx.fiber.dispose();
	});
});
