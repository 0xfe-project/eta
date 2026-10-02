/**
 * The reminder cadence, all the way to a request (H11b).
 *
 * `TaskReminderService` counted turns and emitted an event nobody read: the
 * cadence was real, the nudge never arrived. What is pinned here is the whole
 * path — turns without a task tool make a reminder due, the *next request* carries
 * it as a transient `<system-reminder>` message, and it leaves nothing behind:
 * not in the transcript, not in the journal, not in the cacheable prefix.
 */
import { type KernelTool } from "@eta/core";
import { MemoryStorage } from "@eta/core/storage";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { openSession } from "../src/open";
import { TASK_REVIEW_PROMPT } from "../src/prompts";

const userMsg = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
});

const toolTurn = (name: string) =>
	assistantMessage({
		stopReason: "toolUse",
		content: [
			{ type: "toolCall" as const, id: `c-${name}-${Math.random().toString(36).slice(2, 6)}`, name, arguments: {} },
		],
	});
const stopTurn = () => assistantMessage({ content: [{ type: "text", text: "done" }] });

/** A tool that is not a task tool: it never resets the cadence. */
const plainTool: KernelTool = { name: "read", execute: () => "read done" };

/** The reminder text a request carried, or "" (the message body, not its JSON). */
const reminderOf = (call: { context: { messages: readonly unknown[] } }): string =>
	call.context.messages
		.map((message) =>
			typeof (message as { content?: unknown }).content === "string" ? (message as { content: string }).content : "",
		)
		.filter((text) => text.includes("<system-reminder>"))
		.join("\n");

describe("the reminder reaching a request", () => {
	it("rides the request it was due for, once, and leaves nothing behind", async () => {
		const storage = new MemoryStorage();
		const models = fakeModels([toolTurn("read"), toolTurn("read"), stopTurn(), toolTurn("read"), stopTurn()]);
		const session = await openSession({
			storage,
			models: models as never,
			// Due after one turn without a task tool: the arithmetic is core's and is
			// tested there; what matters here is the wiring.
			reminderInterval: 1,
		});
		session.kernel.tools.register(plainTool);
		session.kernel.tasks.create("finish the harness");
		session.kernel.inject(userMsg("go"));
		await session.runner.run();

		// Turn 1 uses a tool: due after it. Turn 2 is the request that carries it.
		expect(reminderOf(models.calls[0]!)).not.toContain("<system-reminder>");
		expect(reminderOf(models.calls[1]!)).toContain("<system-reminder>");
		expect(reminderOf(models.calls[1]!)).toContain(TASK_REVIEW_PROMPT);
		// Once per cycle: the request after it is clean again.
		expect(reminderOf(models.calls[2]!)).not.toContain("<system-reminder>");

		// And the transcript never holds it, so neither does the journal.
		expect(JSON.stringify(session.log.transcript())).not.toContain("<system-reminder>");
		await session.journaling.flush();
		expect(JSON.stringify(await storage.scanEntries({}))).not.toContain("<system-reminder>");
		// The transcript is what the model was actually given, minus the nudge.
		expect(session.log.transcript().filter((message) => message.role === "user")).toHaveLength(1);

		await session.kernel.dispose();
		session.stop();
	});

	it("does not move the cacheable prefix", async () => {
		const models = fakeModels([toolTurn("read"), toolTurn("read"), stopTurn()]);
		const session = await openSession({
			storage: new MemoryStorage(),
			models: models as never,
			reminderInterval: 1,
			platform: {
				home: "/home/u",
				cwd: "/work",
				configPath: "/cfg",
				memoryTarget: "/work/.eta/MEMORY.md",
				memoryExists: false,
			},
		});
		session.kernel.tools.register(plainTool);
		session.kernel.tasks.create("a task");
		session.kernel.inject(userMsg("go"));
		await session.runner.run();

		const withReminder = models.calls[1]!;
		const without = models.calls[0]!;
		expect(reminderOf(withReminder)).not.toBe("");
		// Same system prompt, byte for byte: the reminder is a message, not prompt text.
		expect(withReminder.context.systemPrompt).toBe(without.context.systemPrompt);
		expect(without.context.systemPrompt ?? "").toContain("<platform>");

		await session.kernel.dispose();
		session.stop();
	});

	it("stays quiet when there is nothing to review", async () => {
		const models = fakeModels([toolTurn("read"), toolTurn("read"), stopTurn()]);
		const session = await openSession({ storage: new MemoryStorage(), models: models as never, reminderInterval: 1 });
		session.kernel.tools.register(plainTool);
		// No tasks: the cadence is a task cadence.
		session.kernel.inject(userMsg("go"));
		await session.runner.run();
		expect(models.calls.map(reminderOf).join("")).not.toContain("<system-reminder>");

		await session.kernel.dispose();
		session.stop();
	});

	it("goes quiet again when a task tool is used", async () => {
		const models = fakeModels([toolTurn("read"), toolTurn("TaskUpdate"), toolTurn("read"), stopTurn()]);
		const session = await openSession({ storage: new MemoryStorage(), models: models as never, reminderInterval: 1 });
		session.kernel.tools.register(plainTool);
		session.kernel.tools.register({ name: "TaskUpdate", execute: () => "ok" });
		session.kernel.tasks.create("a task");
		session.kernel.inject(userMsg("go"));
		await session.runner.run();

		// Turn 1's `read` makes the reminder due, so turn 2's request carries it — the
		// nudge arrives before the `TaskUpdate` that same turn runs…
		expect(reminderOf(models.calls[1]!)).toContain("<system-reminder>");
		// …turn 3's request is clean (the cycle is spent), and turn 3's `read` re-arms
		// the cadence, so turn 4's request carries the next one.
		expect(reminderOf(models.calls[2]!)).toBe("");
		expect(reminderOf(models.calls[3]!)).toContain("<system-reminder>");
		expect(models.calls.filter((call) => reminderOf(call) !== "")).toHaveLength(2);

		await session.kernel.dispose();
		session.stop();
	});

	it("outlives a run: a cycle ends at a task tool, not at a run boundary", async () => {
		const models = fakeModels([
			// Run one: the second tool turn makes the reminder due.
			toolTurn("read"),
			toolTurn("read"),
			stopTurn(),
			// Run two: more tool turns, no task tool anywhere.
			toolTurn("read"),
			stopTurn(),
		]);
		const session = await openSession({ storage: new MemoryStorage(), models: models as never, reminderInterval: 1 });
		session.kernel.tools.register(plainTool);
		session.kernel.tasks.create("a task");

		session.kernel.inject(userMsg("first run"));
		await session.runner.run();
		session.kernel.inject(userMsg("second run"));
		await session.runner.run();

		// One nudge in run one (on the request after the tool that made it due), and
		// none in run two: a run ending is not what starts the next cycle.
		expect(models.calls.map(reminderOf).filter((text) => text !== "")).toHaveLength(1);
		expect(reminderOf(models.calls[1]!)).toContain("<system-reminder>");
		expect(reminderOf(models.calls[3]!)).toBe("");
		// The nudge never entered the transcript, so the journal has nothing to replay.
		expect(JSON.stringify(session.log.transcript())).not.toContain("system-reminder");

		await session.kernel.dispose();
		session.stop();
	});
});
