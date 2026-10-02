import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { piAiModels, THINKING_LEVELS, thinkingLevelsFor } from "../src/kernel/providers";

describe("models seam", () => {
	it("accepts a scripted fake and replays it in order, recording calls", async () => {
		const first = assistantMessage();
		const second = assistantMessage({ stopReason: "toolUse" });
		const fake = fakeModels([first, second]);
		const model = { provider: "fake", id: "m" } as unknown as Model<"openai-completions">;
		const context = { messages: [] };

		expect(await fake.completeSimple(model, context)).toBe(first);
		expect(await fake.completeSimple(model, context)).toBe(second);
		expect(fake.calls).toHaveLength(2);
		expect(fake.calls[0]).toMatchObject({ model });
		expect(fake.getModel("fake", "fake-model")).toBeDefined();
	});

	it("a scripted fake that runs dry fails loudly instead of hanging the loop", async () => {
		const fake = fakeModels([]);
		await expect(fake.completeSimple({} as unknown as Model<"openai-completions">, { messages: [] })).rejects.toThrow(
			"script exhausted",
		);
	});

	it("streams a real pi-ai event sequence derived from the settled message", async () => {
		const settled = assistantMessage({
			content: [{ type: "text", text: "hello" }],
			stopReason: "stop",
		});
		const fake = fakeModels([settled], { chunkSize: 2 });
		const stream = fake.streamSimple({} as unknown as Model<"openai-completions">, { messages: [] });

		const types: string[] = [];
		const deltas: string[] = [];
		for await (const event of stream) {
			types.push(event.type);
			if (event.type === "text_delta") deltas.push(event.delta);
		}
		expect(types).toEqual(["start", "text_start", "text_delta", "text_delta", "text_delta", "text_end", "done"]);
		expect(deltas.join("")).toBe("hello");
		// The stream's own result is the settled message the provider agreed on.
		await expect(stream.result()).resolves.toEqual(settled);
	});

	it("streams tool calls as JSON fragments ending in the tool call itself", async () => {
		const toolCall = { type: "toolCall" as const, id: "c1", name: "bash", arguments: { command: "ls" } };
		const settled = assistantMessage({ content: [toolCall], stopReason: "toolUse" });
		const fake = fakeModels([settled], { chunkSize: 4 });
		const stream = fake.streamSimple({} as unknown as Model<"openai-completions">, { messages: [] });

		const types: string[] = [];
		let json = "";
		let ended: unknown;
		for await (const event of stream) {
			types.push(event.type);
			if (event.type === "toolcall_delta") json += event.delta;
			if (event.type === "toolcall_end") ended = event.toolCall;
		}
		expect(types[0]).toBe("start");
		expect(types).toContain("toolcall_start");
		expect(types.at(-1)).toBe("done");
		expect(JSON.parse(json)).toEqual({ command: "ls" });
		expect(ended).toEqual(toolCall);
	});

	it("an errored message streams as an error event, carrying the settled error", async () => {
		const settled: AssistantMessage = assistantMessage({ stopReason: "error", errorMessage: "boom" });
		const fake = fakeModels([settled]);
		const stream = fake.streamSimple({} as unknown as Model<"openai-completions">, { messages: [] });
		const types: string[] = [];
		for await (const event of stream) types.push(event.type);
		expect(types).toEqual(["start", "error"]);
		await expect(stream.result()).resolves.toEqual(settled);
	});

	it("piAiModels delegates to the injected collection (pi-ai's own shape)", async () => {
		const settled: AssistantMessage = assistantMessage();
		const collection = {
			getModel: () => ({ id: "m" }) as unknown as Model<"openai-completions">,
			streamSimple: () => {
				throw new Error("not used");
			},
			async completeSimple() {
				return settled;
			},
		};
		const seam = piAiModels(collection);
		expect(seam.getModel("p", "m")).toBeDefined();
		const out = await seam.completeSimple(
			{} as unknown as Model<"openai-completions">,
			{ messages: [] },
			{ reasoning: "low" },
		);
		expect(out).toBe(settled);
	});
});

describe("thinking levels a model accepts", () => {
	const model = (extra: Record<string, unknown>) =>
		({ provider: "p", id: "m", api: "openai-completions", reasoning: true, ...extra }) as never;

	it("offers everything when nothing is known about the model", () => {
		expect(thinkingLevelsFor(undefined)).toEqual([...THINKING_LEVELS]);
	});

	it("offers only `off` to a model that does not reason", () => {
		expect(thinkingLevelsFor(model({ reasoning: false }))).toEqual(["off"]);
	});

	it("drops the levels the provider marked unsupported, and keeps the unmentioned ones", () => {
		// `null` is the provider saying "this model does not take this level"; a level the map
		// never mentions is left to the provider's own default, which is why it stays offered.
		expect(thinkingLevelsFor(model({ thinkingLevelMap: { minimal: null, xhigh: null } }))).toEqual([
			"off",
			"low",
			"medium",
			"high",
			"max",
		]);
		expect(thinkingLevelsFor(model({ thinkingLevelMap: { minimal: "low", max: "high" } }))).toEqual([
			...THINKING_LEVELS,
		]);
	});
});
