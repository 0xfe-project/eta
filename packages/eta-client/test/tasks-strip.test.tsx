// @vitest-environment jsdom
/**
 * The task strip above the composer is a window, not the plan.
 *
 * A ten-step plan used to unfold ten wrapped chips over the composer and take the room
 * the conversation needed. Now it is one row per open task in a box three rows tall that
 * scrolls, opened on the newest rows — which is the only reason the plan still reads
 * oldest-first and something has to hold the bottom of the scroll.
 *
 * jsdom has no layout, so `scrollHeight` is 0 and the hold cannot be watched here; what
 * the tests can hold is that every open row is present (nothing is sliced away), that the
 * box is the scroll container, and that the rows stay in plan order.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "@eta/core";
import { FakeSocket } from "./fake-socket.ts";
import { render } from "./render.tsx";

type Task = SessionView["tasks"][number];

const task = (id: string, status = "pending"): Task => ({ id, content: `步骤 ${id}`, status }) as unknown as Task;

function viewWith(tasks: Task[]): SessionView {
	return {
		stateKeys: [],
		messages: [],
		systems: [],
		thinking: [],
		compactionEpoch: 0,
		subagents: [],
		queue: [],
		goal: undefined,
		tasks,
		sideThread: [],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 },
		cacheRate: 0,
		branch: { tipId: null },
		pendingAsk: undefined,
		tools: [],
		personas: [],
		prompt: undefined,
		memory: undefined,
		tokensPerSec: 0,
		loops: [],
	} as unknown as SessionView;
}

async function renderTasks(tasks: Task[]) {
	const { ContextBar } = await import("../src/features/sessions/context-bar.tsx");
	return render(<ContextBar session="s1" view={viewWith(tasks)} />);
}

describe("the task strip above the composer", () => {
	beforeEach(() => {
		vi.stubGlobal("WebSocket", FakeSocket);
		FakeSocket.reset();
	});

	it("keeps every open row, however long the plan is", async () => {
		const ids = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"];
		const view = await renderTasks(ids.map((id) => task(id)));
		for (const id of ids) expect(view.queryByTestId(`task-row-${id}`)).not.toBeNull();
	});

	it("is three rows tall and scrolls, so a plan cannot lift the composer", async () => {
		const view = await renderTasks(["t1", "t2", "t3", "t4"].map((id) => task(id)));
		const box = view.getByTestId("tasks-strip-rows");
		expect(box.className).toContain("overflow-y-auto");
		// 3 × 18px rows + the two 2px gaps: the number is the promise, so it is asserted.
		expect(box.className).toContain("max-h-[58px]");
		expect(box.children).toHaveLength(4);
	});

	it("keeps the rows in plan order, oldest first", async () => {
		const view = await renderTasks(["t1", "t2", "t3"].map((id) => task(id)));
		const order = [...view.getByTestId("tasks-strip-rows").querySelectorAll("[data-testid^='task-row-']")].map(
			(row) => row.getAttribute("data-testid"),
		);
		expect(order).toEqual(["task-row-t1", "task-row-t2", "task-row-t3"]);
	});

	it("does not give a row to a finished or dropped task", async () => {
		const view = await renderTasks([
			task("t1"),
			task("t2", "completed"),
			task("t3", "in_progress"),
			task("t4", "cancelled"),
			task("t5"),
		]);
		expect(view.queryByTestId("task-row-t2")).toBeNull();
		expect(view.queryByTestId("task-row-t4")).toBeNull();
		const order = [...view.getByTestId("tasks-strip-rows").querySelectorAll("[data-testid^='task-row-']")].map(
			(row) => row.getAttribute("data-testid"),
		);
		expect(order).toEqual(["task-row-t1", "task-row-t3", "task-row-t5"]);
	});

	it("marks the row being worked on without spelling out the vocabulary", async () => {
		const view = await renderTasks([task("t1", "in_progress"), task("t2")]);
		expect(view.getByTestId("task-row-t1").textContent).toContain("[▸]");
		expect(view.getByTestId("task-row-t2").textContent).toContain("[ ]");
	});

	it("takes the whole strip away once nothing is open, bar included", async () => {
		const view = await renderTasks([task("t1", "completed"), task("t2", "cancelled")]);
		expect(view.queryByTestId("tasks-list")).toBeNull();
		expect(view.queryByTestId("context-bar")).toBeNull();
	});

	it("marks a row done from the strip, on one click", async () => {
		const view = await renderTasks([task("t1")]);
		view.getByTestId("task-row-t1").click();
		expect(FakeSocket.last()).toMatchObject({ op: "taskSet", session: "s1", id: "t1", status: "completed" });
	});
});
