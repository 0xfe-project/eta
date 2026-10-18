import { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { TaskService } from "../src/kernel/tasks";
import { kernelOn } from "../src/types/events";

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

// Every point below is a line of eta-agent's TaskStore, checked one by one.
describe("task store fidelity against eta-agent's TaskStore", () => {
	it("keeps a self-dependency and warns about it", () => {
		const { tasks, dispose } = withTasks();
		const { task, warnings } = tasks.create("self", { deps: ["t1"] });
		// The edge is kept, and both checks fire: the self-dependency and the
		// cycle it forms (eta-agent's setDeps does not stop at the first warning).
		expect(task.dependsOn).toEqual(["t1"]);
		expect(warnings).toContain("task t1 depends on itself");
		expect(warnings.join(" ")).toContain("dependency cycle");
		dispose();
	});

	it("detects a cycle through a chain, not just a direct loop", () => {
		const { tasks, dispose } = withTasks();
		tasks.create("a");
		tasks.create("b", { deps: ["t1"] });
		const updated = tasks.update("t1", { deps: ["t2"] });
		expect(updated).toBeDefined();
		if (updated === undefined) throw new Error("unreachable");
		expect(updated.warnings.join(" ")).toContain("dependency cycle");
		// The edge is kept: a cycle is reported, not silently broken.
		expect(tasks.get("t1")?.dependsOn).toEqual(["t2"]);
		dispose();
	});

	it("rewriting deps prunes the old reverse edges", () => {
		const { tasks, dispose } = withTasks();
		tasks.create("a");
		tasks.create("b");
		tasks.update("t2", { deps: ["t1"] });
		expect(tasks.get("t1")?.blocks).toEqual(["t2"]);

		tasks.update("t2", { deps: [] });
		expect(tasks.get("t2")?.dependsOn).toEqual([]);
		expect(tasks.get("t1")?.blocks).toEqual([]);
		dispose();
	});

	it("an unknown status warns and leaves the status alone", () => {
		const { tasks, dispose } = withTasks();
		tasks.create("a");
		const result = tasks.update("t1", { status: "nonsense" as never });
		expect(result).toBeDefined();
		if (result === undefined) throw new Error("unreachable");
		expect(result.warnings).toEqual(["unknown status nonsense"]);
		expect(result.task.status).toBe("pending");
		dispose();
	});

	it("updating an unknown task is undefined, not a throw", () => {
		const { tasks, dispose } = withTasks();
		expect(tasks.update("t404", { content: "x" })).toBeUndefined();
		expect(tasks.remove("t404")).toBe(false);
		dispose();
	});

	it("restore keeps the good rows beside the malformed ones", () => {
		const { tasks, dispose } = withTasks();
		const result = tasks.restore([
			{ id: "t1", content: "good", status: "pending", dependsOn: [], blocks: [] },
			{ id: "t2", content: 42, status: "pending" },
			{ id: "t3", content: "also good", status: "cancelled", dependsOn: ["t1", 7], blocks: [] },
		]);
		expect(result.kept).toBe(2);
		expect(result.dropped).toEqual(["t2"]);
		expect(tasks.get("t3")?.dependsOn).toEqual(["t1"]);
		// Auto-ids continue past the highest restored id.
		expect(tasks.create("next").task.id).toBe("t4");
		dispose();
	});
});
