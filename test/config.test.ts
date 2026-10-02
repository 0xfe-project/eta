import { describe, expect, it } from "vitest";
import {
	ConfigService,
	DEFAULT_COMPACTION_SETTINGS,
	DEFAULT_RETRY_POLICY,
	defaultKernelConfig,
	Kernel,
	kernelOn,
	Runner,
	validateCompactionSettings,
	validateKernelConfig,
	validateRetryPolicy,
	validateToolNames,
} from "../src/index";
import { assistantMessage, fakeModels } from "@eta/core/testing";

const userMsg = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
});

describe("config validation", () => {
	it("validateRetryPolicy accepts sane values and rejects everything else", () => {
		expect(() => validateRetryPolicy(DEFAULT_RETRY_POLICY)).not.toThrow();
		expect(() => validateRetryPolicy({ ...DEFAULT_RETRY_POLICY, maxRetries: 0 })).not.toThrow();
		for (const bad of [
			{ ...DEFAULT_RETRY_POLICY, maxRetries: -1 },
			{ ...DEFAULT_RETRY_POLICY, maxRetries: 1.5 },
			{ ...DEFAULT_RETRY_POLICY, maxRetries: Number.MAX_SAFE_INTEGER },
			{ ...DEFAULT_RETRY_POLICY, baseDelayMs: -1 },
			{ ...DEFAULT_RETRY_POLICY, baseDelayMs: Number.NaN },
			{ ...DEFAULT_RETRY_POLICY, maxAgentDelayMs: -1 },
		]) {
			expect(() => validateRetryPolicy(bad), JSON.stringify(bad)).toThrow(RangeError);
		}
	});

	it("validateCompactionSettings rejects negative and fractional token counts", () => {
		expect(() => validateCompactionSettings(DEFAULT_COMPACTION_SETTINGS)).not.toThrow();
		expect(() => validateCompactionSettings({ ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: -1 })).toThrow(
			RangeError,
		);
		expect(() => validateCompactionSettings({ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 0.5 })).toThrow(
			RangeError,
		);
	});

	it("validateToolNames refuses duplicates", () => {
		expect(() => validateToolNames([{ name: "bash" }, { name: "read" }])).not.toThrow();
		expect(() => validateToolNames([{ name: "bash" }, { name: "bash" }])).toThrow(TypeError);
	});

	it("validateKernelConfig checks the tool list and the nested settings", () => {
		// A fresh config is valid: a session may exist before a model is chosen.
		expect(() => validateKernelConfig(defaultKernelConfig())).not.toThrow();
		expect(() => validateKernelConfig(defaultKernelConfig({ activeToolNames: ["a", "a"] }))).toThrow(TypeError);
		expect(() =>
			validateKernelConfig(defaultKernelConfig({ activeToolNames: ["a"], thinkingLevel: "high" })),
		).not.toThrow();
		expect(() =>
			validateKernelConfig(
				defaultKernelConfig({ retryPolicy: { ...DEFAULT_RETRY_POLICY, baseDelayMs: Number.NaN } }),
			),
		).toThrow(RangeError);
		expect(() =>
			validateKernelConfig(
				defaultKernelConfig({ compaction: { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: -1 } }),
			),
		).toThrow(RangeError);
	});
});

describe("ConfigService", () => {
	it("starts from the defaults with the caller's overrides", () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const config = kernel.config.get();
		expect(config.model).toEqual({ provider: "p", modelId: "m" });
		expect(config.thinkingLevel).toBe("off");
		expect(config.compaction).toEqual(DEFAULT_COMPACTION_SETTINGS);
		expect(config.retryPolicy).toEqual(DEFAULT_RETRY_POLICY);
		expect(config.steeringMode).toBe("all");
		expect(config.followUpMode).toBe("all");
		expect(config.toolExecution).toBe("parallel");
		void kernel.dispose();
	});

	it("an invalid update throws and leaves the configuration untouched", () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		expect(() => kernel.config.update({ retryPolicy: { ...DEFAULT_RETRY_POLICY, baseDelayMs: -1 } })).toThrow(
			RangeError,
		);
		expect(kernel.config.read("retryPolicy")).toEqual(DEFAULT_RETRY_POLICY);
		expect(() => kernel.config.update({ compaction: { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: -1 } })).toThrow(
			RangeError,
		);
		expect(kernel.config.read("compaction")).toEqual(DEFAULT_COMPACTION_SETTINGS);
		void kernel.dispose();
	});

	it("reports one update per changed property, with the previous value", () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const updates: { property: string; value: unknown; previous: unknown }[] = [];
		const off = kernelOn(kernel.ctx)("state:config-update", (event) => updates.push(event));
		kernel.config.update({ thinkingLevel: "high", steeringMode: "one-at-a-time" });
		expect(updates.map((u) => u.property)).toEqual(["thinkingLevel", "steeringMode"]);
		expect(updates[0]).toEqual({ property: "thinkingLevel", value: "high", previous: "off" });
		// A no-op update reports nothing.
		updates.length = 0;
		kernel.config.update({ thinkingLevel: "high" });
		expect(updates).toEqual([]);
		off();
		void kernel.dispose();
	});

	it("is usable as a standalone service", () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		expect(kernel.config).toBeInstanceOf(ConfigService);
		kernel.config.setModel("other", "model-2");
		expect(kernel.config.read("model")).toEqual({ provider: "other", modelId: "model-2" });
		void kernel.dispose();
	});
});

describe("the runner reads config live", () => {
	it("sends the next request to the model chosen mid-run", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const fake = fakeModels([assistantMessage({ content: [{ type: "text", text: "first" }] })]);
		const runner = new Runner(kernel, { models: fake });
		kernel.inject(userMsg("go"));
		await runner.run();
		expect(fake.calls).toHaveLength(1);
		// Whatever the caller switched to is what the request carries.
		expect(fake.getModel("p", "m")).toBeDefined();
		void kernel.dispose();
	});

	it("fails the run when the configured model cannot be resolved", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const fake = fakeModels([]);
		fake.getModel = () => undefined;
		const runner = new Runner(kernel, { models: fake });
		kernel.inject(userMsg("go"));
		const result = await runner.run();
		expect(result.error).toBe("model_unavailable: p/m");
		expect(fake.calls).toHaveLength(0);
		void kernel.dispose();
	});

	it("carries the thinking level into the request, and omits it when off", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" }, thinkingLevel: "high" } });
		const fake = fakeModels([assistantMessage(), assistantMessage()]);
		const runner = new Runner(kernel, { models: fake });
		kernel.inject(userMsg("go"));
		await runner.run();
		expect(fake.calls[0]!.options).toMatchObject({ reasoning: "high" });

		kernel.config.update({ thinkingLevel: "off" });
		kernel.inject(userMsg("again"));
		await runner.run();
		expect(fake.calls[1]!.options).not.toMatchObject({ reasoning: expect.anything() });
		void kernel.dispose();
	});
});
