import type {
  Plan,
  PlannerReport,
  PlanTask,
  PlanTaskResult,
} from "../src/subagent-plan";
/**
 * The subagent planner.
 *
 * Three things a plan has to be good for, tested here: tasks that do not depend on
 * each other actually run at the same time; tasks that do, do not; and what came
 * back can change the plan without redoing work or losing the topology.
 */
import { describe, expect, it } from "vitest";
import {
  parsePlan,
  parseReport,
  planWaves,
  replan,
  runPlan,
  taskPrompt,
  validatePlan,
} from "../src/subagent-plan";

const task = (id: string, dependsOn: string[] = []): PlanTask => ({
  id,
  title: id,
  brief: `do ${id}`,
  acceptance: [`${id} is done`],
  dependsOn,
});

const plan = (...tasks: PlanTask[]): Plan => ({ goal: "the goal", tasks });

describe("a plan's shape", () => {
  it("refuses unknown dependencies, duplicates and cycles", () => {
    expect(() => validatePlan(plan(task("a", ["nope"])))).toThrow(
      /unknown task nope/,
    );
    expect(() => validatePlan(plan(task("a"), task("a")))).toThrow(/duplicate/);
    expect(() =>
      validatePlan(plan(task("a", ["c"]), task("b", ["a"]), task("c", ["b"]))),
    ).toThrow(/cycle/);
    expect(() => validatePlan(plan(task("a", ["a"])))).toThrow(
      /depends on itself/,
    );
    // A diamond is not a cycle.
    expect(() =>
      validatePlan(
        plan(
          task("a"),
          task("b", ["a"]),
          task("c", ["a"]),
          task("d", ["b", "c"]),
        ),
      ),
    ).not.toThrow();
  });

  it("groups tasks into the waves their dependencies allow", () => {
    const waves = planWaves(
      plan(
        task("a"),
        task("b"),
        task("c", ["a"]),
        task("d", ["a", "b"]),
        task("e", ["c", "d"]),
      ),
    );
    expect(waves).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });
});

describe("running a plan", () => {
  it("runs tasks with no dependencies on each other at the same time", async () => {
    const live = new Set<string>();
    const overlap: string[] = [];
    const order: string[] = [];
    const results = await runPlan(plan(task("a"), task("b"), task("c")), {
      run: async (current) => {
        live.add(current.id);
        if (live.size > 1) overlap.push([...live].join("+"));
        order.push(`start ${current.id}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        live.delete(current.id);
        return { conclusion: `${current.id} done`, evidence: [], open: [] };
      },
    });
    // All three were in flight together, and each reports its own conclusion.
    expect(overlap.length).toBeGreaterThan(0);
    expect(results.map((result) => result.status)).toEqual([
      "done",
      "done",
      "done",
    ]);
    expect(results.map((result) => result.report?.conclusion)).toEqual([
      "a done",
      "b done",
      "c done",
    ]);
    expect(order.filter((line) => line.startsWith("start"))).toHaveLength(3);
  });

  it("waits for a dependency, and never runs work behind a failure", async () => {
    const order: string[] = [];
    const results = await runPlan(
      plan(task("a"), task("b", ["a"]), task("c", ["b"])),
      {
        run: async (current) => {
          order.push(current.id);
          if (current.id === "a") throw new Error("a fell over");
          return { conclusion: `${current.id} done`, evidence: [], open: [] };
        },
      },
    );
    expect(order).toEqual(["a"]);
    expect(results.map((result) => result.status)).toEqual([
      "failed",
      "blocked",
      "blocked",
    ]);
    expect(results[0]?.error).toContain("a fell over");
    expect(results[1]?.error).toBe("blocked by a");

    // The order a dependency imposes is real: b waits for a, and sees its report.
    const seen: string[] = [];
    await runPlan(plan(task("a"), task("b", ["a"])), {
      run: async (current, currentPlan) => {
        seen.push(current.id);
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(currentPlan.goal).toBe("the goal");
        return { conclusion: `${current.id}`, evidence: [], open: [] };
      },
    });
    expect(seen).toEqual(["a", "b"]);
  });
});

describe("replanning after the work comes back", () => {
  it("adds tasks the results call for, and keeps finished work finished", async () => {
    const original = plan(task("a"), task("b", ["a"]));
    // The first wave has run; b has not, which is when a plan is still free to change.
    const results: PlanTaskResult[] = [
      {
        taskId: "a",
        status: "done",
        report: {
          conclusion: "the assumption held",
          evidence: ["file x"],
          open: [],
        },
      },
    ];

    // What a parent decided after reading a's report: b was mis-scoped into two.
    const revised = replan({
      plan: original,
      results,
      revision: [task("b2", ["a"]), task("c", ["a"])],
      dropped: ["b"],
    });
    expect(revised.tasks.map((current) => current.id)).toEqual([
      "a",
      "b2",
      "c",
    ]);
    expect(planWaves(revised)).toEqual([["a"], ["b2", "c"]]);

    // Finished work is not the revision's to remove or rewrite.
    expect(() =>
      replan({ plan: original, results, revision: [], dropped: ["a"] }),
    ).toThrow(/would drop finished task a/);
    expect(() =>
      replan({ plan: original, results, revision: [task("a", [])] }),
    ).toThrow(/would replace finished task a/);
    // And a revision that breaks the topology is refused like any other plan.
    expect(() =>
      replan({ plan: original, results, revision: [task("d", ["ghost"])] }),
    ).toThrow(/unknown task ghost/);
  });

  it("lets a revision replace a task that has not run yet", () => {
    const original = plan(task("a"), task("b", ["a"]));
    const revised = replan({
      plan: original,
      results: [
        {
          taskId: "a",
          status: "done",
          report: { conclusion: "done", evidence: [], open: [] },
        },
      ],
      revision: [
        {
          ...task("b", ["a"]),
          brief: "do b differently",
          acceptance: ["b is done differently"],
        },
      ],
    });
    expect(revised.tasks[1]?.brief).toBe("do b differently");
    expect(planWaves(revised)).toEqual([["a"], ["b"]]);
  });
});

describe("reading a model's answers", () => {
  it("parses a plan out of a fenced block, normalising what is nearly right", () => {
    const parsed = parsePlan(
      [
        "Here is the plan.",
        "```json",
        JSON.stringify({
          tasks: [
            {
              id: "t1",
              title: "survey",
              brief: "read the code",
              acceptance: "a list of call sites",
              dependsOn: [],
            },
            {
              brief: "migrate",
              acceptance: ["compiles", "tests pass"],
              dependsOn: "t1",
            },
          ],
        }),
        "```",
      ].join("\n"),
      "migrate the API",
    );
    expect(parsed.goal).toBe("migrate the API");
    expect(parsed.tasks[0]?.acceptance).toEqual(["a list of call sites"]);
    // A missing id is numbered, a missing title falls back to the brief, and a
    // single condition or dependency counts as a list of one.
    expect(parsed.tasks[1]?.id).toBe("t2");
    expect(parsed.tasks[1]?.title).toBe("migrate");
    expect(parsed.tasks[1]?.acceptance).toEqual(["compiles", "tests pass"]);
    expect(parsed.tasks[1]?.dependsOn).toEqual(["t1"]);

    // A plan that cannot be made consistent is refused rather than half-used.
    expect(() => parsePlan('{"tasks":[]}')).toThrow(/without any tasks/);
    expect(() =>
      parsePlan(
        '```json\n{"tasks":[{"id":"a","brief":"x","dependsOn":["b"]}]}\n```',
      ),
    ).toThrow(/unknown task b/);
  });

  it("reads a structured report, and does not lose a prose answer", () => {
    const report: PlannerReport = parseReport(
      '```json\n{"conclusion":"the cache is cold","evidence":["dash","logs"],"open":[]}\n```',
    );
    expect(report).toEqual({
      conclusion: "the cache is cold",
      evidence: ["dash", "logs"],
      open: [],
    });
    expect(parseReport("I could not find it.")).toEqual({
      conclusion: "I could not find it.",
      evidence: [],
      open: [],
    });
  });

  it("asks a subtask with its acceptance conditions and the report format", () => {
    const prompt = taskPrompt(task("t1"), plan(task("t1")));
    expect(prompt).toContain("Overall goal: the goal");
    expect(prompt).toContain("Done means:");
    expect(prompt).toContain("- t1 is done");
    expect(prompt).toContain('"conclusion"');
  });
});
