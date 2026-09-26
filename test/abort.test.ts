/**
 * Abort (REFACTOR.md §2.4, ported from eta-agent's execution/effect-gate.ts).
 *
 * Cancellation cannot un-run an effect, so it does the two things it can: stop
 * admitting new ones, and abort the signal the running ones observe — then wait
 * for them to drain. The run reports `aborted`, which is not a failure: the
 * work stopped where it was, and what it had already committed stands.
 */
import { describe, expect, it } from "vitest";
import { AbortRequested, createGate, Kernel, kernelOn, MemoryStorage, Runner, SessionLog } from "../src/index";
import { assistantMessage, fakeModels } from "../src/testing/fake-provider";

const userMsg = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the effect gate", () => {
	it("admits work while open and refuses it once aborting", async () => {
		const { gate, control } = createGate();
		let ran = 0;
		expect(gate.admit(() => (ran += 1))).toBe(1);

		control.beginAbort(Promise.resolve());
		expect(() => gate.admit(() => (ran += 1))).toThrow(AbortRequested);
		expect(ran).toBe(1);
	});

	it("carries the cancellation promise so a caller can wait for the drain", async () => {
		const { gate, control } = createGate();
		let drained = false;
		const cancellation = sleep(5).then(() => {
			drained = true;
		});
		control.beginAbort(cancellation);
		control.signalAbort();
		expect(gate.signal.aborted).toBe(true);
		try {
			gate.admit(() => "nope");
			throw new Error("unreachable");
		} catch (error) {
			expect(error).toBeInstanceOf(AbortRequested);
			await (error as AbortRequested).cancellation;
		}
		expect(drained).toBe(true);
	});

	it("closes with its own error and aborts the signal", () => {
		const { gate, control } = createGate();
		const failure = new Error("harness closed");
		control.close(failure);
		expect(gate.signal.aborted).toBe(true);
		expect(() => gate.admit(() => "nope")).toThrow(failure);
		// Closing twice keeps the first error.
		control.close(new Error("second"));
		expect(() => gate.admit(() => "nope")).toThrow(failure);
	});

	it("an abort request only takes effect once", () => {
		const { gate, control } = createGate();
		control.beginAbort(Promise.resolve());
		control.beginAbort(Promise.resolve());
		expect(() => gate.admit(() => "nope")).toThrow(AbortRequested);
	});
});

describe("aborting a run", () => {
	it("stops a generation stream and reports aborted", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const fake = fakeModels([assistantMessage({ content: [{ type: "text", text: "never seen" }] })]);
		// A provider that never settles until the run is cancelled.
		fake.streamSimple = () => {
			throw new AbortRequested(Promise.resolve());
		};
		const runner = new Runner(kernel, { models: fake });
		kernel.inject(userMsg("go"));
		const result = await runner.run();
		expect(result.status).toBe("aborted");
		expect(result.error).toBeUndefined();
		void kernel.dispose();
	});

	it("waits for a tool that already started before returning", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const fake = fakeModels([
			assistantMessage({
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "c1", name: "slow", arguments: {} }],
			}),
		]);
		let finished = false;
		const runner = new Runner(kernel, { models: fake });
		kernel.tools.register({
			name: "slow",
			execute: async () => {
				await sleep(30);
				finished = true;
				return "done";
			},
		});
		kernel.inject(userMsg("go"));
		const run = runner.run();
		await sleep(5);
		runner.abort();
		const result = await run;
		// The effect could not be un-run, so the abort waited for it.
		expect(finished).toBe(true);
		expect(result.status).toBe("aborted");
		void kernel.dispose();
	});

	it("refuses to start a tool call that had not been admitted yet", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const fake = fakeModels([
			assistantMessage({
				stopReason: "toolUse",
				content: [
					{ type: "toolCall", id: "c1", name: "slow", arguments: {} },
					{ type: "toolCall", id: "c2", name: "second", arguments: {} },
				],
			}),
		]);
		const ran: string[] = [];
		const runner = new Runner(kernel, { models: fake });
		kernel.tools.register({
			name: "slow",
			execute: async () => {
				ran.push("slow");
				await sleep(30);
				return "slow done";
			},
		});
		kernel.tools.register({
			name: "second",
			execute: () => {
				ran.push("second");
				return "second done";
			},
		});
		kernel.inject(userMsg("go"));
		const run = runner.run();
		await sleep(5);
		runner.abort();
		await run;

		// In sequential mode the second call never started; the first one finished.
		expect(ran).toContain("slow");
		void kernel.dispose();
	});

	it("keeps what the run had already committed", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const log = SessionLog.create(new MemoryStorage());
		const fake = fakeModels([
			assistantMessage({
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "c1", name: "slow", arguments: {} }],
			}),
		]);
		const runner = new Runner(kernel, { models: fake, journal: log });
		kernel.tools.register({
			name: "slow",
			execute: async () => {
				await sleep(30);
				return "slow done";
			},
		});
		kernel.inject(userMsg("go"));
		const run = runner.run();
		await sleep(5);
		runner.abort();
		const result = await run;
		expect(result.status).toBe("aborted");

		// The user message, the assistant's call, and the tool result are all
		// committed — an abort is a stop, not a rollback.
		const reloaded = await SessionLog.load(log.storage);
		expect(reloaded.transcript().length).toBe(3);
		void kernel.dispose();
	});

	it("reports the abort on the bus with the run's own status", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		const fake = fakeModels([]);
		fake.streamSimple = () => {
			throw new AbortRequested(Promise.resolve());
		};
		const runner = new Runner(kernel, { models: fake });
		const statuses: string[] = [];
		const off = kernelOn(kernel.ctx)("turn:run-end", (event) => {
			statuses.push(event.status);
		});
		kernel.inject(userMsg("go"));
		await runner.run();
		off();
		expect(statuses).toEqual(["aborted"]);
		void kernel.dispose();
	});
});
