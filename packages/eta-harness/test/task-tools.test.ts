/**
 * The task and state tools.
 *
 * The claim under test is the one a snapshot cannot fake: a task list and a
 * stored key are *written down*, so reopening the session finds them. The tools
 * are thin over the kernel's ledger and the journal's KV — that thinness is what
 * makes "it is still there" a real assertion rather than an echo.
 */
import { SessionLog } from "@eta/core/session";
import { MemoryStorage } from "@eta/core/storage";
import { fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { openSession } from "../src/open";
import { sessionStateKV } from "../src/state";
import { journaledKernel } from "../src/testing";
import { createStateTools } from "../src/tools/state";
import { createTaskTools, TASK_TOOL_NAMES } from "../src/tools/tasks";
import { toKernelTool } from "../src/tools/tool";

const _userMsg = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
});

/** A kernel with the task and state tools registered, as a deployment wires them. */
const call = { turn: 1, toolCallId: "c1" } as never;

function session() {
	const { kernel, journaling } = journaledKernel(SessionLog.create(new MemoryStorage()));
	for (const tool of createTaskTools(kernel.tasks)) kernel.tools.register(toKernelTool(tool, () => undefined));
	for (const tool of createStateTools(sessionStateKV(journaling.log!, journaling))) {
		kernel.tools.register(toKernelTool(tool, () => undefined));
	}
	kernel.config.update({ activeToolNames: [...TASK_TOOL_NAMES, "update_state", "check_state", "list_state"] });
	return { kernel, journaling };
}

const textOf = (result: unknown): string =>
	typeof result === "object" && result !== null && Array.isArray((result as { content?: unknown }).content)
		? (result as { content: { type: string; text?: string }[] }).content
				.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
				.join("\n")
		: String(result);

describe("task tools", () => {
	it("creates, lists, reads and updates the session's own ledger", async () => {
		const { kernel } = session();
		const tools = kernel.tools;
		const created = await tools.execute("TaskCreate", { content: "write the tests", priority: "high" }, call);
		expect(textOf(created)).toContain("Created t1.");
		expect(textOf(created)).toContain("Updated TODOs.");
		const second = await tools.execute("TaskCreate", { content: "then ship it", deps: ["t1"] }, call);
		expect(textOf(second)).toContain("Created t2.");

		const listed = textOf(await tools.execute("TaskList", {}, call));
		expect(listed).toContain("<current_tasks>");
		expect(listed).toContain("[ ] t1: write the tests");
		expect(listed).toContain("[ ] t2: then ship it");

		const one = textOf(await tools.execute("TaskGet", { id: "t2" }, call));
		expect(one).toContain('"dependsOn":["t1"]');

		await tools.execute("TaskUpdate", { id: "t1", status: "completed" }, call);
		const after = textOf(await tools.execute("TaskList", {}, call));
		expect(after).toContain("[x] t1: write the tests");
	});

	it("says so plainly when a task does not exist", async () => {
		const { kernel } = session();
		expect(textOf(await kernel.tools.execute("TaskGet", { id: "t99" }, call))).toBe("No task t99.");
		expect(textOf(await kernel.tools.execute("TaskUpdate", { id: "t99", status: "completed" }, call))).toBe(
			"No task t99.",
		);
	});

	it("keeps the ledger across a restart, because it was written down", async () => {
		const storage = new MemoryStorage();
		const first = await openSession({ storage, models: fakeModels([]) });
		for (const tool of createTaskTools(first.kernel.tasks)) {
			first.kernel.tools.register(toKernelTool(tool, () => undefined));
		}
		await first.kernel.tools.execute("TaskCreate", { content: "survive the restart" }, call);
		await first.kernel.tools.execute("TaskCreate", { content: "and keep its edges", deps: ["t1"] }, call);
		await first.journaling.flush();
		await first.kernel.dispose();

		const again = await openSession({ storage, models: fakeModels([]) });
		// A deployment installs its tools on every session it opens.
		for (const tool of createTaskTools(again.kernel.tasks)) {
			again.kernel.tools.register(toKernelTool(tool, () => undefined));
		}
		const listed = textOf(await again.kernel.tools.execute("TaskList", {}, call));
		expect(listed).toContain("[ ] t1: survive the restart");
		expect(listed).toContain("[ ] t2: and keep its edges");
		expect(again.tasks?.kept).toBe(2);
		await again.kernel.dispose();
	});
});

describe("state tools", () => {
	it("stores, reads, lists and deletes keys — through the journal", async () => {
		const { kernel, journaling } = session();
		expect(textOf(await kernel.tools.execute("check_state", { key: "plan" }, call))).toBe("plan is not set.");
		expect(textOf(await kernel.tools.execute("list_state", {}, call))).toBe("No state keys.");

		expect(textOf(await kernel.tools.execute("update_state", { key: "plan", value: "green" }, call))).toBe(
			"Stored plan.",
		);
		expect(textOf(await kernel.tools.execute("check_state", { key: "plan" }, call))).toBe("green");
		await kernel.tools.execute("update_state", { key: "other", value: "blue" }, call);
		expect(textOf(await kernel.tools.execute("list_state", {}, call))).toBe("other\nplan");

		// A stored key is committed, not held in a variable: the write waited for
		// the disk before the tool answered.
		await journaling.flush();

		expect(textOf(await kernel.tools.execute("update_state", { key: "plan", value: null }, call))).toBe(
			"Deleted plan.",
		);
		expect(textOf(await kernel.tools.execute("check_state", { key: "plan" }, call))).toBe("plan is not set.");
		expect(textOf(await kernel.tools.execute("list_state", {}, call))).toBe("other");
	});

	it("finds its keys again after a restart", async () => {
		const storage = new MemoryStorage();
		const first = await openSession({ storage, models: fakeModels([]) });
		for (const tool of createStateTools(sessionStateKV(first.log, first.journaling))) {
			first.kernel.tools.register(toKernelTool(tool, () => undefined));
		}
		await first.kernel.tools.execute("update_state", { key: "note", value: "remember me" }, call);
		await first.kernel.dispose();

		const again = await openSession({ storage, models: fakeModels([]) });
		for (const tool of createStateTools(sessionStateKV(again.log, again.journaling))) {
			again.kernel.tools.register(toKernelTool(tool, () => undefined));
		}
		expect(textOf(await again.kernel.tools.execute("check_state", { key: "note" }, call))).toBe("remember me");
		await again.kernel.dispose();
	});
});
