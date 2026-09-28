/**
 * Tool progress reports (REFACTOR.md §2.4 step 4).
 *
 * A tool that takes a while (a streamed command, a long edit) can report where
 * it is; the kernel turns that into tool:update on the bus. Two rules matter:
 * partial results are snapshots like every other payload, and the channel is
 * only open while the call runs — a tool that keeps streaming after it settled
 * must not publish into a finished call (eta-agent's acceptingUpdates).
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type KernelTool, kernelOn, MemoryStorage, Runner, SessionLog, type ToolCallInfo } from "@eta/core";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { journaledKernel } from "../src/testing";

const userMsg = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
});

const toolTurn = (calls: { id: string; name: string }[]): AssistantMessage =>
	assistantMessage({
		stopReason: "toolUse",
		content: calls.map((call) => ({ type: "toolCall" as const, ...call, arguments: {} })),
	});

function setup(script: AssistantMessage[], tools: KernelTool[]) {
	const { kernel, journaling } = journaledKernel(SessionLog.create(new MemoryStorage()));
	const fake = fakeModels(script);
	const runner = new Runner(kernel, { models: fake, journal: journaling });
	for (const tool of tools) kernel.tools.register(tool);
	const updates: { toolCallId: string; toolName: string; partialResult: unknown; checkpoint?: boolean }[] = [];
	const names: string[] = [];
	const on = kernelOn(kernel.ctx);
	const offs = [
		on("tool:update", (event) => {
			names.push("tool:update");
			updates.push(event as never);
		}),
		on("tool:start", () => {
			names.push("tool:start");
		}),
		on("tool:end", () => {
			names.push("tool:end");
		}),
	];
	return {
		kernel,
		runner,
		fake,
		updates,
		names,
		dispose: () => {
			for (const off of offs) off();
			void kernel.dispose();
		},
	};
}

describe("tool:update", () => {
	it("carries a checkpoint flag through the update channel", async () => {
		const marking: KernelTool = {
			name: "marking",
			execute: async (_args, call: ToolCallInfo) => {
				call.update?.("halfway", { checkpoint: true });
				call.update?.("just a frame");
				return "done";
			},
		};
		const context = setup(
			[toolTurn([{ id: "c1", name: "marking" }]), assistantMessage({ content: [{ type: "text", text: "ok" }] })],
			[marking],
		);
		context.kernel.inject(userMsg("go"));
		await context.runner.run();
		expect(context.updates.map((update) => update.checkpoint === true)).toEqual([true, false]);
		expect(context.updates[0]?.partialResult).toBe("halfway");
		context.dispose();
	});

	it("reports progress in order, between tool:start and tool:end", async () => {
		const streaming: KernelTool = {
			name: "run",
			execute: async (_args, call: ToolCallInfo) => {
				for (const line of ["line 1", "line 2", "line 3"]) {
					call.update?.(line);
					await new Promise((resolve) => setTimeout(resolve, 1));
				}
				return "done";
			},
		};
		const { kernel, runner, updates, names, dispose } = setup(
			[toolTurn([{ id: "c1", name: "run" }]), assistantMessage({ content: [{ type: "text", text: "ok" }] })],
			[streaming],
		);
		kernel.inject(userMsg("go"));
		await runner.run();

		expect(updates.map((event) => event.partialResult)).toEqual(["line 1", "line 2", "line 3"]);
		expect(updates.every((event) => event.toolCallId === "c1" && event.toolName === "run")).toBe(true);
		// Every update sits between the call's start and its end.
		const first = names.indexOf("tool:start");
		const last = names.indexOf("tool:end");
		const between = names.slice(first, last).filter((name) => name === "tool:update");
		expect(between).toHaveLength(3);
		dispose();
	});

	it("a tool that never reports produces no update", async () => {
		const quiet: KernelTool = { name: "quiet", execute: () => "silent" };
		const { kernel, runner, updates, names, dispose } = setup(
			[toolTurn([{ id: "c1", name: "quiet" }]), assistantMessage()],
			[quiet],
		);
		kernel.inject(userMsg("go"));
		await runner.run();
		expect(updates).toEqual([]);
		expect(names).toEqual(["tool:start", "tool:end"]);
		dispose();
	});

	it("drops updates that arrive after the call settled", async () => {
		let late: ((partial: unknown) => void) | undefined;
		const sneaky: KernelTool = {
			name: "sneaky",
			execute: (_args, call: ToolCallInfo) => {
				late = call.update;
				call.update?.("while running");
				return "finished";
			},
		};
		const { kernel, runner, updates, dispose } = setup(
			[toolTurn([{ id: "c1", name: "sneaky" }]), assistantMessage()],
			[sneaky],
		);
		kernel.inject(userMsg("go"));
		await runner.run();

		expect(updates.map((event) => event.partialResult)).toEqual(["while running"]);
		// The channel is closed now: the tool still holds the callback, and it does
		// nothing.
		late?.("after the fact");
		expect(updates.map((event) => event.partialResult)).toEqual(["while running"]);
		dispose();
	});

	it("stops accepting updates when the tool throws", async () => {
		let late: ((partial: unknown) => void) | undefined;
		const failing: KernelTool = {
			name: "failing",
			execute: (_args, call: ToolCallInfo) => {
				late = call.update;
				throw new Error("boom");
			},
		};
		const { kernel, runner, updates, dispose } = setup(
			[toolTurn([{ id: "c1", name: "failing" }]), assistantMessage()],
			[failing],
		);
		kernel.inject(userMsg("go"));
		await runner.run();
		late?.("too late");
		expect(updates).toEqual([]);
		dispose();
	});

	it("reports per call, so a parallel batch does not mix them up", async () => {
		const streamer = (tag: string): KernelTool => ({
			name: tag,
			execute: async (_args, call: ToolCallInfo) => {
				call.update?.(`${tag}:1`);
				call.update?.(`${tag}:2`);
				return tag;
			},
		});
		const { kernel, runner, updates, dispose } = setup(
			[
				toolTurn([
					{ id: "c1", name: "alpha" },
					{ id: "c2", name: "beta" },
				]),
				assistantMessage(),
			],
			[streamer("alpha"), streamer("beta")],
		);
		kernel.inject(userMsg("go"));
		await runner.run();

		const byCall = new Map<string, unknown[]>();
		for (const event of updates) {
			const list = byCall.get(event.toolCallId) ?? [];
			list.push(event.partialResult);
			byCall.set(event.toolCallId, list);
		}
		expect(byCall.get("c1")).toEqual(["alpha:1", "alpha:2"]);
		expect(byCall.get("c2")).toEqual(["beta:1", "beta:2"]);
		dispose();
	});

	it("hands over a snapshot, not the tool's live object", async () => {
		const mutable = { lines: ["first"] };
		const streaming: KernelTool = {
			name: "mutable",
			execute: (_args, call: ToolCallInfo) => {
				call.update?.(mutable);
				mutable.lines.push("second");
				return "done";
			},
		};
		const { kernel, runner, updates, dispose } = setup(
			[toolTurn([{ id: "c1", name: "mutable" }]), assistantMessage()],
			[streaming],
		);
		kernel.inject(userMsg("go"));
		await runner.run();
		expect(updates[0]!.partialResult).toEqual({ lines: ["first"] });
		dispose();
	});

	it("partial results never reach the journal", async () => {
		const storage = new MemoryStorage();
		const log = SessionLog.create(storage);
		const { kernel, journaling } = journaledKernel(log, { config: { model: { provider: "p", modelId: "m" } } });
		const fake = fakeModels([
			toolTurn([{ id: "c1", name: "run" }]),
			assistantMessage({ content: [{ type: "text", text: "ok" }] }),
		]);
		const runner = new Runner(kernel, { models: fake, journal: journaling });
		kernel.tools.register({
			name: "run",
			execute: (_args, call: ToolCallInfo) => {
				call.update?.("progress that must not be persisted");
				return "done";
			},
		});
		kernel.inject(userMsg("go"));
		await runner.run();
		const journal = JSON.stringify(await storage.scanEntries({}));
		expect(journal).not.toContain("progress that must not be persisted");
		expect(journal).toContain("done");
		void kernel.dispose();
	});
});
