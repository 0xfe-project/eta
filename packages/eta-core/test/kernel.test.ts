import { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/index";

describe("kernel assembly", () => {
  it("creates a context with the three primitives attached", () => {
    const kernel = Kernel.create();
    expect(kernel.inspect()).toMatchObject({
      maxTurns: null,
      turns: 0,
      budgetSpent: false,
      goal: undefined,
      tasks: [],
      personas: [],
      activePersonaNames: [],
      inboxDepth: 0,
    });
    // Each primitive is live, and inspect() reads it back.
    kernel.goal.set("an objective");
    kernel.tasks.create("a task");
    kernel.persona.loadCards([{ id: "ada", name: "Ada", content: "" }]);
    kernel.persona.setActive(["ada"]);
    expect(kernel.inspect()).toMatchObject({
      goal: { objective: "an objective" },
      tasks: [{ content: "a task" }],
      personas: [{ id: "ada" }],
      activePersonaNames: ["ada"],
    });
    void kernel.dispose();
  });

  it("scopes service names under a parent, so two kernels can hang off one root", () => {
    const root = new Context();
    const first = Kernel.create({ parent: root });
    const second = Kernel.create({ parent: root });
    // Sharing a root is not sharing state: two kernels, two of everything.
    expect(first.ctx).not.toBe(second.ctx);
    first.goal.set("the first kernel's goal");
    expect(first.goal.current?.objective).toBe("the first kernel's goal");
    expect(second.goal.current).toBeUndefined();
    second.tasks.create("the second kernel's task");
    expect(first.tasks.list()).toEqual([]);
    // The names belong to each kernel's scope, not to the parent.
    expect((root as unknown as { goal?: unknown }).goal).toBeUndefined();
    void first.dispose();
    void second.dispose();
    void root.fiber.dispose();
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
});
