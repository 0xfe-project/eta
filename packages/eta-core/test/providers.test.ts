import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type ProviderSeam, piAiProviders } from "../src/kernel/providers.ts";
import { assistantMessage, fakeProvider } from "../src/testing/fake-provider.ts";

describe("providers seam", () => {
	it("accepts a scripted fake and replays it in order, recording calls", async () => {
		const first = assistantMessage();
		const second = assistantMessage({ stopReason: "toolUse" });
		const fake = fakeProvider([first, second]);
		const model = { provider: "fake", modelId: "m" } as never;
		const context = [] as never;
		expect(await fake.complete(model, context)).toBe(first);
		expect(await fake.complete(model, context)).toBe(second);
		expect(fake.calls).toHaveLength(2);
		expect(fake.calls[0]).toMatchObject({ model });
	});

	it("a scripted fake that runs dry fails loudly instead of hanging the loop", async () => {
		const fake = fakeProvider([]);
		await expect(fake.complete({} as never, [] as never)).rejects.toThrow("script exhausted");
	});

	it("piAiProviders delegates to the injected adapter (the pi-ai compat surface)", async () => {
		const settled: AssistantMessage = assistantMessage();
		const adapter = {
			async completeSimple() {
				return settled;
			},
		};
		const seam: ProviderSeam = piAiProviders(adapter);
		const out = await seam.complete({} as never, [] as never, { thinkingLevel: "low" } as never);
		expect(out).toBe(settled);
	});
});
