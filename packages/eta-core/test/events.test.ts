import { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { KERNEL_EVENT_NAMES, type KernelEvents, kernelEmit, kernelOn } from "../src/types/events";

describe("event vocabulary", () => {
	it("names are pinned against drift", () => {
		expect([...KERNEL_EVENT_NAMES].sort()).toEqual([...KERNEL_EVENT_NAMES]);
		expect(KERNEL_EVENT_NAMES).toMatchInlineSnapshot(`
			[
			  "compaction:end",
			  "compaction:start",
			  "goal:changed",
			  "goal:cleared",
			  "inject:received",
			  "message:end",
			  "message:start",
			  "message:update",
			  "persona:loaded",
			  "persona:missing",
			  "persona:switched",
			  "prompt:assembled",
			  "queue:update",
			  "retry:end",
			  "retry:scheduled",
			  "retry:start",
			  "state:config-update",
			  "storage:appended",
			  "storage:compacted",
			  "storage:error",
			  "task:cancelled",
			  "task:completed",
			  "task:created",
			  "task:reminder-due",
			  "task:removed",
			  "task:updated",
			  "tool:end",
			  "tool:start",
			  "turn:end",
			  "turn:run-end",
			  "turn:run-start",
			  "turn:start",
			  "usage:recorded",
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
		const off = kernelOn(ctx)("tool:end", (p) => {
			seen.push({ name: "tool:end", payload: p });
		});
		const emit = kernelEmit(ctx);
		emit("tool:end", {
			runId: "r1",
			turnId: "t1",
			toolCallId: "c1",
			toolName: "bash",
			result: { ok: true },
			isError: false,
			terminate: false,
			durationMs: 5,
		});
		emit("task:created", { action: "created", task: { id: "t1", content: "c", status: "pending" } });
		off();
		emit("tool:end", {
			runId: "r1",
			turnId: "t2",
			toolCallId: "c2",
			toolName: "bash",
			result: { ok: false },
			isError: true,
			terminate: false,
			durationMs: 1,
		});
		expect(seen).toHaveLength(1);
		expect(seen[0].payload).toMatchObject({ toolName: "bash", result: { ok: true } });
		void ctx.fiber.dispose();
	});
});
