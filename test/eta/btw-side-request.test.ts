import { describe, expect, it } from "vitest";
import type { AssistantMessage, Models, Usage } from "@earendil-works/pi-ai";
import { btwSideAsk, BtwManager } from "../../src/harness/btw.ts";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import type { AgentToolCall, AgentToolResultMessage } from "../../src/types.ts";
import type { LaneRequestState } from "../../src/harness/runtime/types.ts";

function usage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function textAnswer(text: string, totalTokens = 40): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: usage(totalTokens),
		stopReason: "stop",
		timestamp: 0,
	} as unknown as AssistantMessage;
}

function toolAnswer(toolName: string, totalTokens = 40): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `call-${Math.random()}`, name: toolName, arguments: {} }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: usage(totalTokens),
		stopReason: "toolUse",
		timestamp: 0,
	} as unknown as AssistantMessage;
}

function errorAnswer(message: string): AssistantMessage {
	return { ...textAnswer(""), stopReason: "error", errorMessage: message } as unknown as AssistantMessage;
}

interface SentRequest {
	modelId: string;
	systemPrompt: string;
	toolNames: string[];
	messages: unknown[];
}

/** A provider registry that records what each side turn actually sent. */
function fauxModels(responses: AssistantMessage[]): { models: Models; sent: SentRequest[] } {
	const remaining = [...responses];
	const sent: SentRequest[] = [];
	const models = {
		model: { id: "current", provider: "faux" },
		completeSimple: async (model: { id: string }, context: { systemPrompt?: string; messages: unknown[]; tools?: { name: string }[] }) => {
			sent.push({
				modelId: model.id,
				systemPrompt: context.systemPrompt ?? "",
				toolNames: (context.tools ?? []).map((tool) => tool.name),
				messages: context.messages,
			});
			const response = remaining.shift();
			if (response === undefined) throw new Error("no faux response queued");
			return response;
		},
	} as unknown as Models;
	return { models, sent };
}

function requestState(overrides: Partial<LaneRequestState<object | undefined>> = {}): LaneRequestState<object | undefined> {
	return {
		model: { id: "current", provider: "faux" } as never,
		thinkingLevel: "off",
		tools: [
			{ name: "read", description: "read a file", parameters: { type: "object", properties: {} } },
			{ name: "ask_user", description: "ask the user", parameters: { type: "object", properties: {} } },
		],
		missingToolNames: [],
		systemPrompt: "the main agent's prompt",
		...overrides,
	};
}

function toolResult(call: AgentToolCall, text: string): AgentToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	} as AgentToolResultMessage;
}

describe("btw side request", () => {
	it("inherits the session's model, prompt and tools, read at ask time", async () => {
		// One `requestState` per request: a model switch between two questions has to
		// reach the second one without anything being rebuilt.
		let state = requestState();
		const { models, sent } = fauxModels([textAnswer("first"), textAnswer("second")]);
		const mgr = new BtwManager(
			() => ({ messages: [] }),
			undefined,
			undefined,
			btwSideAsk({
				models,
				requestState: async () => state,
				executeTool: async () => toolResult({ id: "x", name: "read", arguments: {} }, "ok"),
				context: BACKGROUND_CONTEXT,
			}),
		);
		const thread = mgr.create("tangent");
		await mgr.ask(thread.id, "first question");
		state = requestState({ model: { id: "swapped", provider: "faux" } as never, systemPrompt: "a newer prompt" });
		await mgr.ask(thread.id, "second question");

		expect(sent.map((request) => request.modelId)).toEqual(["current", "swapped"]);
		expect(sent[1]?.systemPrompt).toBe("a newer prompt");
		expect(mgr.get(thread.id)?.exchanges.map((exchange) => exchange.answer)).toEqual(["first", "second"]);
	});

	it("does not offer ask_user to a side request", async () => {
		const { models, sent } = fauxModels([textAnswer("ok")]);
		const mgr = new BtwManager(
			() => ({ messages: [] }),
			undefined,
			undefined,
			btwSideAsk({
				models,
				requestState: async () => requestState(),
				executeTool: async () => toolResult({ id: "x", name: "read", arguments: {} }, "ok"),
				context: BACKGROUND_CONTEXT,
			}),
		);
		const thread = mgr.create("tangent");
		await mgr.ask(thread.id, "why is this not blocked on a human");
		// `ask_user` waits for a person, and the GUI has one question slot the main run
		// owns — offering it to a side request would stall the channel it belongs to.
		expect(sent[0]?.toolNames).toEqual(["read"]);
	});

	it("runs a tool, replays its result, and records that it ran", async () => {
		const ran: string[] = [];
		const { models, sent } = fauxModels([toolAnswer("read"), textAnswer("the file says 42")]);
		const mgr = new BtwManager(
			() => ({ messages: [] }),
			undefined,
			undefined,
			btwSideAsk({
				models,
				requestState: async () => requestState(),
				executeTool: async (call, info) => {
					ran.push(call.name);
					// The tool context is the one the prompt was built with, not a new one.
					expect(info.turn).toBe(0);
					return toolResult(call, "42");
				},
				context: BACKGROUND_CONTEXT,
			}),
		);
		const thread = mgr.create("tangent");
		await mgr.ask(thread.id, "what does the file say");

		expect(ran).toEqual(["read"]);
		expect(mgr.get(thread.id)?.exchanges[0]).toMatchObject({
			question: "what does the file say",
			answer: "the file says 42",
			steps: [{ tool: "read", ok: true }],
		});
		// The second turn carries the tool result, or the model would answer blind.
		expect(sent[1]?.messages.map((message) => (message as { role: string }).role)).toContain("toolResult");
	});

	it("carries the wait, then clears it", async () => {
		let resolve!: (response: AssistantMessage) => void;
		const models = {
			model: { id: "current", provider: "faux" },
			completeSimple: () =>
				new Promise<AssistantMessage>((resolvePromise) => {
					resolve = resolvePromise;
				}),
		} as unknown as Models;
		const events: string[] = [];
		const mgr = new BtwManager(
			() => ({ messages: [] }),
			undefined,
			(category, action) => events.push(`${category}/${action}`),
			btwSideAsk({
				models,
				requestState: async () => requestState(),
				executeTool: async () => toolResult({ id: "x", name: "read", arguments: {} }, "ok"),
				context: BACKGROUND_CONTEXT,
			}),
		);
		const thread = mgr.create("tangent");
		const settled = mgr.ask(thread.id, "slow question");
		// The thread reports the wait before the answer exists: the panel must not look frozen.
		expect(mgr.get(thread.id)?.pending?.question).toBe("slow question");
		// One tick for the request to reach the provider, which is where the answer is handed back.
		await new Promise((tick) => setTimeout(tick, 0));
		resolve(textAnswer("late but correct"));
		await settled;
		expect(mgr.get(thread.id)?.pending).toBeUndefined();
		expect(events).toContain("btw/asking");
		expect(events).toContain("btw/injected");
	});

	it("records a failure as an error, not as an answer", async () => {
		const mgr = new BtwManager(
			() => ({ messages: [] }),
			undefined,
			undefined,
			btwSideAsk({
				models: fauxModels([errorAnswer("provider exploded")]).models,
				requestState: async () => requestState(),
				executeTool: async () => toolResult({ id: "x", name: "read", arguments: {} }, "ok"),
				context: BACKGROUND_CONTEXT,
			}),
		);
		const thread = mgr.create("tangent");
		await mgr.ask(thread.id, "will this lie?");
		expect(mgr.get(thread.id)?.exchanges).toEqual([]);
		expect(mgr.get(thread.id)?.error).toBe("provider exploded");
	});

	it("stops the tool loop at its turn cap and says so", async () => {
		const ran: string[] = [];
		const mgr = new BtwManager(
			() => ({ messages: [] }),
			undefined,
			undefined,
			btwSideAsk({
				models: fauxModels([
					toolAnswer("read"),
					toolAnswer("read"),
					toolAnswer("read"),
					toolAnswer("read"),
					toolAnswer("read"),
					toolAnswer("read"),
				]).models,
				requestState: async () => requestState(),
				executeTool: async (call) => {
					ran.push(call.name);
					return toolResult(call, "still going");
				},
				context: BACKGROUND_CONTEXT,
			}),
		);
		const thread = mgr.create("tangent");
		await mgr.ask(thread.id, "keep looking");
		// Turns are bounded, so a model that keeps calling tools still produces an answer
		// and the answer admits it was cut short.
		expect(ran.length).toBe(4);
		expect(mgr.get(thread.id)?.exchanges[0]?.answer).toContain("stopped at 1 pending tool calls");
	});

	it("charges the session for the whole question, tagged as side traffic", async () => {
		const charged: Usage[] = [];
		const mgr = new BtwManager(
			() => ({ messages: [] }),
			undefined,
			undefined,
			btwSideAsk({
				models: fauxModels([toolAnswer("read", 100), textAnswer("done", 60)]).models,
				requestState: async () => requestState(),
				executeTool: async (call) => toolResult(call, "ok"),
				context: BACKGROUND_CONTEXT,
				onUsage: (total) => charged.push(total),
			}),
		);
		const thread = mgr.create("tangent");
		await mgr.ask(thread.id, "cost?");
		// One charge per question, summing every turn of its tool loop.
		expect(charged.length).toBe(1);
		expect(charged[0]?.totalTokens).toBe(160);
	});

	it("answers even when an active tool has no implementation", async () => {
		const mgr = new BtwManager(
			() => ({ messages: [] }),
			undefined,
			undefined,
			btwSideAsk({
				models: fauxModels([textAnswer("answered anyway")]).models,
				requestState: async () => requestState({ missingToolNames: ["bash"] }),
				executeTool: async (call) => toolResult(call, "ok"),
				context: BACKGROUND_CONTEXT,
			}),
		);
		const thread = mgr.create("tangent");
		await mgr.ask(thread.id, "can you still reply?");
		expect(mgr.get(thread.id)?.exchanges[0]?.answer).toContain("bash");
	});
});
