import { describe, expect, it } from "vitest";
import { TaskStore } from "../../src/harness/task-store.ts";
import { createCadenceState, drainReminderForContext, evaluateToolResult, onTurnStart } from "../../src/harness/cadence.ts";
import { createReminderHooks, createStateTools, createTaskTools, TASK_TOOL_NAMES } from "../../src/harness/tools/index.ts";
import { GoalManager, applyGoalEntries } from "../../src/harness/goal.ts";
import { normalizeAskOptions } from "../../src/harness/ask.ts";

describe("task store", () => {
	it("auto-ids never get reused", () => {
		const s = new TaskStore();
		const a = s.create("a");
		s.create("b");
		s.update(a.task.id, { status: "cancelled" });
		const c = s.create("c");
		expect(c.task.id).toBe("t3");
	});
	it("deps build reverse edges and cycle warnings, edges kept", () => {
		const s = new TaskStore();
		const a = s.create("a");
		const b = s.create("b", { deps: [a.task.id] });
		expect(a.task.blocks).toEqual([b.task.id]);
		const cyc = s.update(a.task.id, { deps: [b.task.id] });
		expect(cyc?.warnings.some((w) => w.includes("cycle"))).toBe(true);
		expect(a.task.dependsOn).toEqual([b.task.id]);
		const self = s.update(a.task.id, { deps: [a.task.id] });
		expect(self?.warnings.some((w) => w.includes("itself"))).toBe(true);
	});
	it("load guard drops malformed rows and reports them", () => {
		const s = new TaskStore();
		const r = s.deserialize([
			{ id: "t1", content: "ok", status: "pending" },
			{ id: "t2", content: "bad status", status: "done" },
			{ content: "no id", status: "pending" },
		]);
		expect(r.kept).toBe(1);
		expect(r.dropped).toEqual(["t2", "unknown"]);
		expect(s.list().length).toBe(1);
		s.create("fresh");
		expect(s.list().map((t) => t.id)).toEqual(["t1", "t2"]);
	});
});

describe("reminder cadence (ported)", () => {
	const config = { reminderInterval: 3, taskToolNames: TASK_TOOL_NAMES };
	it("goes due after N tool-free turns with tasks, fires once per cycle", () => {
		const st = createCadenceState();
		onTurnStart(st);
		expect(evaluateToolResult(st, "read", true, config).markDue).toBe(false);
		onTurnStart(st);
		onTurnStart(st);
		onTurnStart(st);
		expect(evaluateToolResult(st, "read", true, config).markDue).toBe(true);
		expect(drainReminderForContext(st)).toBe(true);
		expect(drainReminderForContext(st)).toBe(false);
		expect(evaluateToolResult(st, "read", true, config).markDue).toBe(false);
	});
	it("task tools reset and no tasks means no nag", () => {
		const st = createCadenceState();
		for (let i = 0; i < 10; i++) onTurnStart(st);
		expect(evaluateToolResult(st, "read", false, config).markDue).toBe(false);
		evaluateToolResult(st, "TaskUpdate", true, config);
		expect(evaluateToolResult(st, "read", true, config).markDue).toBe(false);
	});
});

describe("tools", () => {
	it("task tools create/list/update through the store", async () => {
		const store = new TaskStore();
		const tools = createTaskTools(store);
		const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
		const created = await byName.TaskCreate.execute("c", { content: "wire tools", deps: [], priority: "high" }, () => {}, {}, fakeInvocation, ctx() as never);
		expect(JSON.stringify(created.details)).toContain("t1");
		await byName.TaskUpdate.execute("c", { id: "t1", status: "in_progress" }, () => {}, {}, fakeInvocation, ctx() as never);
		const listed = await byName.TaskList.execute("c", {}, () => {}, {}, fakeInvocation, ctx() as never);
		expect(String((listed.content[0] as { text: string }).text)).toContain("[~] t1: wire tools");
	});
	it("state tools round-trip", async () => {
		const map = new Map<string, string>();
		const kv = {
			get: async (k: string) => map.get(k),
			set: async (k: string, v: string | null) => { if (v === null) map.delete(k); else map.set(k, v); },
			keys: async () => [...map.keys()],
		};
		const tools = createStateTools(kv);
		const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
		await byName.update_state.execute("c", { key: "eta.demo", value: "42" }, () => {}, {}, fakeInvocation, ctx() as never);
		const read = await byName.check_state.execute("c", { key: "eta.demo" }, () => {}, {}, fakeInvocation, ctx() as never);
		expect(String((read.content[0] as { text: string }).text)).toBe("42");
		await byName.update_state.execute("c", { key: "eta.demo", value: null }, () => {}, {}, fakeInvocation, ctx() as never);
		const gone = await byName.check_state.execute("c", { key: "eta.demo" }, () => {}, {}, fakeInvocation, ctx() as never);
		expect(String((gone.content[0] as { text: string }).text)).toContain("not set");
	});
	it("reminder injects transiently at context time", () => {
		const store = new TaskStore();
		store.create("open thing");
		const hooks = createReminderHooks(store, 1);
		hooks.onTurnStart();
		hooks.afterTool({ toolName: "read" });
		hooks.onTurnStart();
		const out = hooks.transformContext({ messages: [] });
		expect(out?.messages.length).toBe(1);
		expect(JSON.stringify(out?.messages[0])).toContain("<system-reminder>");
		expect(hooks.transformContext({ messages: [] })).toBeUndefined();
	});
});

describe("goal replay + ask normalization", () => {
	it("replays goal lifecycle from entries", () => {
		const m = new GoalManager();
		applyGoalEntries(m, [
			{ type: "goal", payload: { kind: "set", objective: "ship" } },
			{ type: "goal", payload: { kind: "pause" } },
			{ type: "goal", payload: { kind: "resume" } },
			{ type: "noise", payload: {} },
		]);
		expect(m.current?.objective).toBe("ship");
		expect(m.current?.status).toBe("active");
	});
	it("normalizes renamed option keys", () => {
		expect(normalizeAskOptions(["plain", { label: "a", detail: "why" }, { value: "b" }])).toEqual([
			{ title: "plain" },
			{ title: "a", description: "why" },
			{ title: "b" },
		]);
		expect(normalizeAskOptions(undefined)).toBeUndefined();
	});
});

const fakeInvocation = { invocationId: "i", operationId: "o", turnId: "t", getMemo: async () => undefined, setMemo: async () => {} };
function ctx() { return { value: () => undefined, abortSignal: undefined }; }
