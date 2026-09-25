import { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { renderCurrentTasks, TaskService } from "../src/kernel/tasks.ts";
import { kernelOn } from "../src/types/events.ts";

function withTasks() {
	const ctx = new Context();
	const tasks = new TaskService(ctx);
	const events: { name: string; action: string }[] = [];
	const on = kernelOn(ctx);
	const offs = (["task:created", "task:updated", "task:removed", "task:completed", "task:cancelled"] as const).map(
		(name) => on(name, (p) => events.push({ name, action: p.action })),
	);
	return {
		ctx,
		tasks,
		events,
		dispose: () => {
			for (const off of offs) off();
			void ctx.fiber.dispose();
		},
	};
}

describe("task store semantics", () => {
	it("auto-ids never get reused", () => {
		const { tasks, dispose } = withTasks();
		const a = tasks.create("a");
		tasks.create("b");
		tasks.update(a.task.id, { status: "cancelled" });
		const c = tasks.create("c");
		expect(c.task.id).toBe("t3");
		dispose();
	});

	it("deps build reverse edges and cycle warnings, edges kept", () => {
		const { tasks, dispose } = withTasks();
		const a = tasks.create("a");
		const b = tasks.create("b", { deps: [a.task.id] });
		expect(a.task.blocks).toEqual([b.task.id]);
		const cyc = tasks.update(a.task.id, { deps: [b.task.id] });
		expect(cyc?.warnings.some((w) => w.includes("cycle"))).toBe(true);
		expect(a.task.dependsOn).toEqual([b.task.id]);
		const self = tasks.update(a.task.id, { deps: [a.task.id] });
		expect(self?.warnings.some((w) => w.includes("itself"))).toBe(true);
		dispose();
	});

	it("unknown deps are dropped with a warning", () => {
		const { tasks, dispose } = withTasks();
		const a = tasks.create("a", { deps: ["nope"] });
		expect(a.warnings.some((w) => w.includes("unknown dependency"))).toBe(true);
		expect(a.task.dependsOn).toEqual([]);
		dispose();
	});

	it("remove prunes dangling references", () => {
		const { tasks, dispose } = withTasks();
		const a = tasks.create("a");
		const b = tasks.create("b", { deps: [a.task.id] });
		expect(tasks.remove(a.task.id)).toBe(true);
		expect(b.task.dependsOn).toEqual([]);
		expect(tasks.remove("missing")).toBe(false);
		dispose();
	});

	it("load guard drops malformed rows and reports them; ids never reused across restore", () => {
		const { tasks, dispose } = withTasks();
		const r = tasks.restore([
			{ id: "t1", content: "ok", status: "pending" },
			{ id: "t2", content: "bad status", status: "done" },
			{ content: "no id", status: "pending" },
		]);
		expect(r.kept).toBe(1);
		expect(r.dropped).toEqual(["t2", "unknown"]);
		expect(tasks.list().length).toBe(1);
		const fresh = tasks.create("fresh");
		expect(fresh.task.id).toBe("t2");
		expect(tasks.list().map((t) => t.id)).toEqual(["t1", "t2"]);
		dispose();
	});

	it("restore with a non-array is a total drop", () => {
		const { tasks, dispose } = withTasks();
		expect(tasks.restore("junk")).toEqual({ kept: 0, dropped: ["root"] });
		dispose();
	});
});

describe("task bus events", () => {
	it("create/remove/update emit their events", () => {
		const { tasks, events, dispose } = withTasks();
		const a = tasks.create("a");
		tasks.update(a.task.id, { content: "a2" });
		tasks.remove(a.task.id);
		expect(events.map((e) => e.name)).toEqual(["task:created", "task:updated", "task:removed"]);
		dispose();
	});

	it("completion and cancellation fire the semantic alias alongside task:updated", () => {
		const { tasks, events, dispose } = withTasks();
		const a = tasks.create("a");
		const b = tasks.create("b");
		tasks.update(a.task.id, { status: "completed" });
		tasks.update(b.task.id, { status: "cancelled" });
		expect(events.map((e) => e.name)).toEqual([
			"task:created",
			"task:created",
			"task:completed",
			"task:updated",
			"task:cancelled",
			"task:updated",
		]);
		dispose();
	});

	it("re-setting the same status does not re-fire the alias", () => {
		const { tasks, events, dispose } = withTasks();
		const a = tasks.create("a");
		tasks.update(a.task.id, { status: "completed" });
		tasks.update(a.task.id, { status: "completed" });
		const aliases = events.filter((e) => e.name === "task:completed");
		expect(aliases).toHaveLength(1);
		dispose();
	});
});

describe("renderCurrentTasks", () => {
	it("renders all four states with marks", () => {
		const { tasks, dispose } = withTasks();
		const a = tasks.create("pending task");
		const b = tasks.create("doing task");
		tasks.update(b.task.id, { status: "in_progress" });
		const c = tasks.create("done task");
		tasks.update(c.task.id, { status: "completed" });
		const d = tasks.create("killed task");
		tasks.update(d.task.id, { status: "cancelled" });
		const out = renderCurrentTasks(tasks.list());
		expect(out).toBe(
			`<current_tasks>\n[ ] ${a.task.id}: pending task\n[~] ${b.task.id}: doing task\n[x] ${c.task.id}: done task\n[-] ${d.task.id}: killed task\n</current_tasks>`,
		);
		dispose();
	});
});
