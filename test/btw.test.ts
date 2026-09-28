/**
 * btw — the side request.
 *
 * The claims worth checking are the ones a side channel gets wrong: it must not
 * disturb the run it sits beside, it must inherit the run's own state (so a model
 * switch applies at once), it must not inherit the tool that would steal the
 * user's attention, and it must not run forever.
 */
import { type AgentMessage, MemoryStorage, Runner, SessionLog, type ToolCall } from "@eta/core";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { btwSideAsk, SIDE_MAX_TOOL_TURNS } from "../src/btw";
import { journaledKernel } from "../src/testing";

const userMsg = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 });

/** A session with a runner, so `requestState()` is the real thing. */
function session(script: Parameters<typeof fakeModels>[0], tools: { name: string }[] = []) {
	const { kernel, journaling } = journaledKernel(SessionLog.create(new MemoryStorage()));
	for (const tool of tools) kernel.tools.register({ name: tool.name, execute: () => "tool output" });
	const fake = fakeModels(script);
	const runner = new Runner(kernel, { models: fake, journal: journaling, systemPrompt: "SYSTEM" });
	return { kernel, runner, fake };
}

const answer = (text: string) =>
	assistantMessage({
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});

describe("a side request", () => {
	it("answers from the run's own state, and reports what it cost", async () => {
		const { runner, fake } = session([answer("the side answer")]);
		const executions: string[] = [];
		const ask = btwSideAsk({
			models: fake,
			requestState: () => runner.requestState(),
			executeTool: async (call: ToolCall) => {
				executions.push(call.name);
				return {
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: "tool output" }],
					timestamp: 0,
				} as never as AgentMessage;
			},
		});
		const result = await ask({ threadId: "t1", question: "what is this?", messages: [] });
		expect(result.text).toBe("the side answer");
		expect(result.usage.totalTokens).toBe(15);
		expect(result.steps).toEqual([]);
		expect(executions).toEqual([]);
		// The request the side call made is the run's own: same prompt, same model.
		const call = fake.calls.at(-1)!;
		expect(call.context.systemPrompt).toBe("SYSTEM");
		expect(call.context.messages.at(-1)).toMatchObject({ role: "user" });
		expect(JSON.stringify(call.context.messages.at(-1))).toContain("what is this?");
	});

	it("leaves ask_user out of what it may call, so a side question cannot steal the slot", async () => {
		const { kernel, runner, fake } = session([answer("done")], [{ name: "read" }, { name: "ask_user" }]);
		kernel.config.update({ activeToolNames: ["read", "ask_user"] });
		const ask = btwSideAsk({
			models: fake,
			requestState: () => runner.requestState(),
			executeTool: async () => {
				throw new Error("no tool should have run");
			},
		});
		await ask({ threadId: "t1", question: "quick one", messages: [] });
		const declared = fake.calls.at(-1)!.context.tools ?? [];
		expect(declared.map((tool) => tool.name)).toEqual(["read"]);
		void kernel;

		// And if the model calls it anyway (a model can call a tool that was never
		// declared), the side request answers "unknown tool" rather than waiting for
		// a human it could not reach.
		const { runner: secondRunner, fake: secondFake } = (() => {
			const made = session(
				[
					assistantMessage({
						stopReason: "toolUse",
						content: [{ type: "toolCall", id: "c9", name: "ask_user", arguments: { question: "?" } }],
					}),
					answer("answered without asking"),
				],
				[{ name: "ask_user" }],
			);
			made.kernel.config.update({ activeToolNames: ["ask_user"] });
			return made;
		})();
		const ran: string[] = [];
		const sideAsk = btwSideAsk({
			models: secondFake,
			requestState: () => secondRunner.requestState(),
			executeTool: async (call) => {
				ran.push(call.name);
				return {
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: "tool output" }],
					timestamp: 0,
				} as never as AgentMessage;
			},
		});
		const result = await sideAsk({ threadId: "t2", question: "quick one", messages: [] });
		expect(ran).toEqual([]);
		expect(result.steps).toEqual([{ tool: "ask_user", ok: false, at: expect.any(Number) }]);
		expect(JSON.stringify(secondFake.calls.at(-1)!.context.messages)).toContain("unknown tool: ask_user");
	});

	it("runs tools through the kernel's own chain, and keeps going until the answer", async () => {
		const { runner, fake, kernel } = session(
			[
				assistantMessage({
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } }],
				}),
				answer("after using the tool"),
			],
			[{ name: "read" }],
		);
		const ran: string[] = [];
		const ask = btwSideAsk({
			models: fake,
			requestState: () => runner.requestState(),
			executeTool: async (call) => {
				ran.push(call.name);
				return {
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: "file contents" }],
					isError: false,
					timestamp: 0,
				} as AgentMessage;
			},
		});
		const result = await ask({ threadId: "t1", question: "read it", messages: [] });
		expect(ran).toEqual(["read"]);
		expect(result.steps).toEqual([{ tool: "read", ok: true, at: expect.any(Number) }]);
		expect(result.text).toBe("after using the tool");
		// The second request carried the tool result, exactly like a run.
		expect(JSON.stringify(fake.calls.at(-1)!.context.messages)).toContain("file contents");
		void kernel.dispose();
	});

	it("stops after a few tool turns and still answers", async () => {
		const toolTurn = assistantMessage({
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
		});
		const { kernel, runner, fake } = session(
			[toolTurn, toolTurn, toolTurn, toolTurn, toolTurn, toolTurn, toolTurn],
			[{ name: "read" }],
		);
		const ask = btwSideAsk({
			models: fake,
			requestState: () => runner.requestState(),
			executeTool: async (call) =>
				({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: "again" }],
					timestamp: 0,
				}) as AgentMessage,
		});
		const result = await ask({ threadId: "t1", question: "keep going", messages: [] });
		expect(result.text).toContain("budget ran out");
		expect(fake.calls.length).toBeLessThanOrEqual(SIDE_MAX_TOOL_TURNS + 2);
		void kernel.dispose();
	});

	it("refuses to answer with a channel that is not there, instead of inventing one", async () => {
		const { kernel, runner, fake } = session([answer("never")]);
		const ask = btwSideAsk({
			models: fake,
			requestState: async () => undefined,
			executeTool: async () => {
				throw new Error("no tool should have run");
			},
		});
		await expect(ask({ threadId: "t1", question: "?", messages: [] })).rejects.toThrow(/no session to inherit/);
		// A failed side request is a rejection, not a fake answer a thread would replay.
		const failing = btwSideAsk({
			models: fakeModels([assistantMessage({ stopReason: "error", errorMessage: "upstream 500" })]),
			requestState: () => runner.requestState(),
			executeTool: async () => {
				throw new Error("no tool should have run");
			},
		});
		await expect(failing({ threadId: "t1", question: "?", messages: [] })).rejects.toThrow("upstream 500");
		void kernel.dispose();
	});

	it("says which tools the session never had, rather than failing over the gap", async () => {
		const { kernel, runner, fake } = session([answer("answered anyway")]);
		kernel.config.update({ activeToolNames: ["read"] });
		const ask = btwSideAsk({
			models: fake,
			requestState: () => runner.requestState(),
			executeTool: async () => {
				throw new Error("no tool should have run");
			},
		});
		const result = await ask({ threadId: "t1", question: "hello", messages: [] });
		expect(result.text).toContain("unavailable this time: read");
		void kernel.dispose();
	});

	it("does not disturb the run it sits beside", async () => {
		const { kernel, runner, fake } = session([answer("main turn"), answer("side turn")]);
		kernel.inject(userMsg("main question"));
		await runner.run();
		const transcriptBefore = runner.getTranscript().length;
		const ask = btwSideAsk({
			models: fake,
			requestState: () => runner.requestState(),
			executeTool: async () => {
				throw new Error("no tool should have run");
			},
		});
		await ask({ threadId: "t1", question: "side question", messages: [] });
		// The run's own transcript is untouched: nothing about the side request
		// entered the session's history or its inbox.
		expect(runner.getTranscript()).toHaveLength(transcriptBefore);
		expect(kernel.inboxDepth).toBe(0);
		void kernel.dispose();
	});
});
