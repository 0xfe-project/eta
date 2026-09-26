import { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { GoalService, Kernel } from "../src/index";
import { kernelOn } from "../src/types/events";

describe("kernel assembly", () => {
	it("creates a context with the three primitives attached", () => {
		const kernel = Kernel.create();
		expect(kernel.goal).toBeInstanceOf(GoalService);
		expect(kernel.maxTurns).toBeNull();
		expect(kernel.inspect()).toMatchObject({
			maxTurns: null,
			turns: 0,
			budgetSpent: false,
			goal: undefined,
			inboxDepth: 0,
		});
		void kernel.dispose();
	});

	it("honours a parent context: services on the child are visible from it, not vice versa", () => {
		const root = new Context();
		const kernel = Kernel.create({ parent: root });
		// Child services are resolvable through the parent's view.
		const viaRoot = (root as unknown as { goal: { current?: { objective?: string } } }).goal;
		kernel.goal.set("visible from root");
		expect(viaRoot.current?.objective).toBe("visible from root");
		// A sibling child context exists and stays independent.
		const sibling = root.extend();
		expect(sibling).not.toBe(kernel.ctx);
		void kernel.dispose();
		void sibling.fiber.dispose();
		void root.fiber.dispose();
	});

	it("primitives are privileged: registry.delete is a no-op on them", () => {
		const kernel = Kernel.create();
		const registry = kernel.ctx.registry;
		// Nothing to find: they never entered the plugin registry.
		// Not found in the registry: delete returns nothing and changes nothing.
		expect(registry.delete(kernel.goal as unknown as Parameters<typeof registry.delete>[0])).toBeFalsy();
		// And the service still works.
		kernel.goal.set("still here");
		expect(kernel.goal.current?.objective).toBe("still here");
		void kernel.dispose();
	});

	it("ctx.get returns a traceable view, not the instance: shared state, no reference equality", () => {
		const kernel = Kernel.create();
		const viaCtx = (kernel.ctx as unknown as { goal: GoalService }).goal;
		expect(viaCtx).not.toBe(kernel.goal);
		// Mutations through the kernel are visible through the view.
		kernel.goal.set("objective");
		expect(viaCtx.current?.objective).toBe("objective");
		viaCtx.pause();
		expect(kernel.goal.current?.status).toBe("paused");
		void kernel.dispose();
	});

	it("turn budget: null is unlimited, finite spends exactly", () => {
		const unlimited = Kernel.create();
		for (let i = 0; i < 100; i++) expect(unlimited.noteTurn()).toBe(true);
		expect(unlimited.budgetSpent).toBe(false);
		void unlimited.dispose();

		const finite = Kernel.create({ maxTurns: 3 });
		expect(finite.noteTurn()).toBe(true);
		expect(finite.noteTurn()).toBe(true);
		expect(finite.noteTurn()).toBe(false);
		expect(finite.turns).toBe(3);
		expect(finite.budgetSpent).toBe(true);
		void finite.dispose();
	});

	it("inject queues FIFO, emits inject:received, drains atomically", () => {
		const kernel = Kernel.create();
		const received: unknown[] = [];
		const off = kernelOn(kernel.ctx)("inject:received", (p) => received.push(p.message));
		const msg = (text: string) => ({
			role: "user" as const,
			content: [{ type: "text" as const, text }],
			timestamp: 0,
		});
		kernel.inject(msg("one"));
		kernel.inject(msg("two"));
		expect(kernel.inboxDepth).toBe(2);
		expect(received).toHaveLength(2);
		const accepted = kernel.acceptInbox();
		const texts = accepted.map((item) => {
			const message = item.message;
			if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return "";
			return ((message.content as { text: string }[])[0] ?? { text: "" }).text;
		});
		expect(texts).toEqual(["one", "two"]);
		expect(kernel.inboxDepth).toBe(0);
		// Taking again is empty, not an error.
		expect(kernel.acceptInbox()).toEqual([]);
		off();
		void kernel.dispose();
	});
});
