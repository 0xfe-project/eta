/**
 * The inbox (REFACTOR.md §2.5, ported from eta-agent's lane inbox).
 *
 * The rules that matter: steering never interrupts a turn — it waits for the
 * next checkpoint; a follow-up only continues a run that had nothing else to
 * do; a next-run item waits for the run after this one; and both queue modes
 * apply per kind, so follow-ups can be held in reserve while steering lands.
 */
import type { ImageContent } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	Inbox,
	InvalidMessage,
	Kernel,
	kernelOn,
	normalizeQueuedInput,
	type QueuedItem,
	Runner,
} from "../src/index.ts";
import { assistantMessage, fakeModels } from "../src/testing/fake-provider.ts";

const userMsg = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
});

const image = { type: "image" as const, mimeType: "image/png", data: "AAAA" } as unknown as ImageContent;

function textOf(item: { message: { role: string; content?: unknown } } | QueuedItem): string {
	const message = item.message as { role: string; content?: unknown };
	if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as { type: string; text?: string }[])
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("");
}

describe("queued input validation", () => {
	it("requires text or an image", () => {
		expect(() => normalizeQueuedInput("")).toThrow(InvalidMessage);
		try {
			normalizeQueuedInput("");
			throw new Error("unreachable");
		} catch (error) {
			expect((error as InvalidMessage).reason).toBe("empty");
		}
		// An image alone is enough, and lands as a user message.
		const withImage = normalizeQueuedInput("", [image]);
		expect(withImage.role).toBe("user");
		expect((withImage as { content: unknown[] }).content).toHaveLength(1);
	});

	it("refuses a pending assistant message", () => {
		const pending = { ...assistantMessage(), stopReason: "pending" as const };
		expect(() => normalizeQueuedInput(pending as never)).toThrow(InvalidMessage);
		try {
			normalizeQueuedInput(pending as never);
			throw new Error("unreachable");
		} catch (error) {
			expect((error as InvalidMessage).reason).toBe("pending_assistant");
		}
	});

	it("attaches images only to user messages", () => {
		try {
			normalizeQueuedInput(assistantMessage() as never, [image]);
			throw new Error("unreachable");
		} catch (error) {
			expect((error as InvalidMessage).reason).toBe("images_with_non_user");
		}
		// A user message keeps its text and gains the image.
		const merged = normalizeQueuedInput(userMsg("look at this"), [image]) as { content: unknown[] };
		expect(merged.content).toHaveLength(2);
	});
});

describe("inbox kinds and modes", () => {
	it("accepts next-run items always, and steering/follow-ups per mode", () => {
		const inbox = new Inbox();
		inbox.enqueue("steer", "steer one");
		inbox.enqueue("steer", "steer two");
		inbox.enqueue("followUp", "follow one");
		inbox.enqueue("followUp", "follow two");
		inbox.enqueue("nextRun", "for the next run");

		// one-at-a-time: the earliest of each kind, plus every next-run item.
		inbox.configure({ steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" });
		const accepted = inbox.accept();
		expect(accepted.map(textOf)).toEqual(["steer one", "follow one", "for the next run"]);
		// Steer two waits for the next checkpoint; follow two for the next boundary.
		expect(inbox.list().map((item) => item.kind)).toEqual(["steer", "followUp"]);

		inbox.configure({ steeringMode: "all", followUpMode: "all" });
		expect(inbox.accept().map(textOf)).toEqual(["steer two", "follow two"]);
		expect(inbox.depth).toBe(0);
	});

	it("preserves queue order across kinds", () => {
		const inbox = new Inbox();
		inbox.enqueue("followUp", "first");
		inbox.enqueue("steer", "second");
		inbox.enqueue("nextRun", "third");
		expect(inbox.accept().map(textOf)).toEqual(["first", "second", "third"]);
	});

	it("a boundary takes steering only, unless a follow-up is allowed to continue", () => {
		const inbox = new Inbox();
		inbox.enqueue("steer", "s1");
		inbox.enqueue("steer", "s2");
		inbox.enqueue("followUp", "f1");

		const steeringOnly = inbox.takeAtBoundary({ followUpWhenNoTrigger: false });
		expect(steeringOnly.steers.map(textOf)).toEqual(["s1", "s2"]);
		expect(steeringOnly.followUps).toEqual([]);
		// The follow-up is still waiting, and a run that may finish takes it.
		const continuing = inbox.takeAtBoundary({ followUpWhenNoTrigger: true });
		expect(continuing.steers).toEqual([]);
		expect(continuing.followUps.map(textOf)).toEqual(["f1"]);
		expect(inbox.depth).toBe(0);
	});

	it("respects the mode when taking at a boundary too", () => {
		const inbox = new Inbox();
		inbox.configure({ followUpMode: "one-at-a-time" });
		inbox.enqueue("followUp", "f1");
		inbox.enqueue("followUp", "f2");
		expect(inbox.takeAtBoundary({ followUpWhenNoTrigger: true }).followUps.map(textOf)).toEqual(["f1"]);
		expect(inbox.list().map(textOf)).toEqual(["f2"]);
	});

	it("cancels a queued item and reports whether it was still there", () => {
		const inbox = new Inbox();
		const item = inbox.enqueue("steer", "regret");
		expect(inbox.cancel(item.entryId)).toBe(true);
		expect(inbox.depth).toBe(0);
		expect(inbox.cancel(item.entryId)).toBe(false);
	});
});

describe("the kernel's inbox", () => {
	it("inject queues steering and reports the receipt", () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const received: string[] = [];
		const off = kernelOn(kernel.ctx)("inject:received", (event) => {
			received.push(textOf({ message: event.message as never }));
		});
		kernel.inject(userMsg("from outside"));
		kernel.steer("explicit steer");
		kernel.followUp("explicit follow-up");
		kernel.nextRun("later");
		expect(received).toEqual(["from outside"]);
		expect(kernel.inbox.list().map((item) => item.kind)).toEqual(["steer", "steer", "followUp", "nextRun"]);
		off();
		void kernel.dispose();
	});

	it("cancelQueued drops an item before the runner can take it", () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const item = kernel.steer("never mind");
		expect(kernel.cancelQueued(item.entryId)).toBe(true);
		expect(kernel.inboxDepth).toBe(0);
		void kernel.dispose();
	});
});

describe("what the runner does with each kind", () => {
	it("an item queued before the run starts is taken by that run", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const fake = fakeModels([assistantMessage({ content: [{ type: "text", text: "answer" }] })]);
		const runner = new Runner(kernel, { models: fake });
		kernel.inject(userMsg("go"));
		kernel.followUp("one more thing");
		kernel.nextRun("and this one too");
		await runner.run();
		// The run accepts what is waiting when it starts: one request, both items.
		expect(fake.calls).toHaveLength(1);
		const first = JSON.stringify(fake.calls[0]!.context.messages);
		expect(first).toContain("one more thing");
		expect(first).toContain("and this one too");
		expect(kernel.inboxDepth).toBe(0);
		void kernel.dispose();
	});

	it("a follow-up queued mid-run continues the run that was about to stop", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const fake = fakeModels([
			assistantMessage({
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "c1", name: "queue", arguments: {} }],
			}),
			assistantMessage({ content: [{ type: "text", text: "first" }] }),
			assistantMessage({ content: [{ type: "text", text: "after follow-up" }] }),
		]);
		const runner = new Runner(kernel, { models: fake });
		kernel.tools.register({
			name: "queue",
			execute: () => {
				kernel.followUp("one more thing");
				return "queued";
			},
		});
		kernel.inject(userMsg("go"));
		await runner.run();

		// The follow-up did not interrupt the tool turn, and it continued the run
		// once the assistant had nothing left to say.
		expect(fake.calls).toHaveLength(3);
		expect(JSON.stringify(fake.calls[1]!.context.messages)).not.toContain("one more thing");
		expect(JSON.stringify(fake.calls[2]!.context.messages)).toContain("one more thing");
		expect(kernel.inboxDepth).toBe(0);
		void kernel.dispose();
	});

	it("a next-run item queued mid-run does not disturb the run in flight", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const fake = fakeModels([
			assistantMessage({
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "c1", name: "queue", arguments: {} }],
			}),
			assistantMessage({ content: [{ type: "text", text: "done" }] }),
		]);
		const runner = new Runner(kernel, { models: fake });
		kernel.tools.register({
			name: "queue",
			execute: () => {
				kernel.nextRun("for later");
				return "queued";
			},
		});
		kernel.inject(userMsg("go"));
		await runner.run();

		// Two requests (the tool turn and its answer), and the next-run item is
		// still waiting: it is not a reason to continue this run.
		expect(fake.calls).toHaveLength(2);
		expect(kernel.inboxDepth).toBe(1);
		void kernel.dispose();
	});

	it("one-at-a-time steering holds the second steer until the next checkpoint", async () => {
		const kernel = Kernel.create({
			config: { model: { provider: "p", modelId: "m" }, steeringMode: "one-at-a-time" },
		});
		const fake = fakeModels([
			assistantMessage({ content: [{ type: "text", text: "one" }] }),
			assistantMessage({ content: [{ type: "text", text: "two" }] }),
		]);
		const runner = new Runner(kernel, { models: fake });
		kernel.inject(userMsg("go"));
		kernel.steer("second steer");
		await runner.run();
		// The run takes the injected message first; the queued steer lands at the
		// boundary and gets the next request.
		expect(fake.calls).toHaveLength(2);
		expect(JSON.stringify(fake.calls[0]!.context.messages)).not.toContain("second steer");
		expect(JSON.stringify(fake.calls[1]!.context.messages)).toContain("second steer");
		void kernel.dispose();
	});
});
