import type { Task } from "@/queries/tasks";
import { describe, expect, it } from "@rstest/core";
import {
  edgeRefusal,
  filterTasks,
  planOf,
  progressOf,
  releaseOf,
  stepAmongSiblings,
  waitSummary,
} from "./task-plan";
import { board, release } from "./task-tree-fixture";

const numbers = (tasks: readonly Task[]) => tasks.map((t) => t.number);
const pick = (all: Task[], ...ns: number[]) =>
  all.filter((t) => ns.includes(t.number));

describe("steps", () => {
  it("lays the design's tree out in three steps, side by side within a step", () => {
    const all = release();
    const plan = planOf(all.filter((t) => t.parentId === "t4"));
    expect(plan.steps.map(numbers)).toEqual([[5, 6], [7, 8], [9]]);
  });

  it("puts a task after the latest of what it waits for, across steps", () => {
    // 3 waits for 1 (step 1) and 2 (step 2): it is step 3, not step 2.
    const all = board([
      { number: 1 },
      { number: 2, after: [1] },
      { number: 3, after: [1, 2] },
      { number: 4, after: [1] },
    ]);
    const plan = planOf(all);
    expect(plan.steps.map(numbers)).toEqual([[1], [2, 4], [3]]);
  });

  it("puts a task that waits for nothing in the first step", () => {
    const all = board([
      { number: 1 },
      { number: 2 },
      { number: 3, after: [1] },
    ]);
    const plan = planOf(all);
    expect(plan.steps.map(numbers)).toEqual([[1, 2], [3]]);
    expect(plan.stepOf.get("t2")).toBe(1);
  });

  it("does not count edges to tasks outside the plan", () => {
    const all = board([
      { number: 1 },
      { number: 2, after: [1] },
      { number: 3, after: [2] },
    ]);
    const plan = planOf(pick(all, 2, 3));
    expect(plan.steps.map(numbers)).toEqual([[2], [3]]);
    expect(plan.edges).toEqual([{ from: "t2", to: "t3", requireDone: false }]);
  });

  it("gives a subtask its step among its parent's subtasks", () => {
    const all = release();
    expect(stepAmongSiblings(all.find((t) => t.number === 9)!, all)).toBe(3);
    expect(
      stepAmongSiblings(all.find((t) => t.number === 2)!, all),
    ).toBeUndefined();
  });

  it("survives a cycle the host would never have let in", () => {
    const all = board([
      { number: 1, after: [2] },
      { number: 2, after: [1] },
    ]);
    expect(planOf(all).steps.flat()).toHaveLength(2);
  });
});

describe("the critical path", () => {
  it("is the longest chain, through what still holds the work up", () => {
    const all = release();
    const plan = planOf(all.filter((t) => t.parentId === "t4"));
    // 7 is delivered already, so the chain that matters goes through 8; 5 and 6 tie, the lower wins.
    expect(plan.critical).toEqual(["t5", "t8", "t9"]);
  });

  it("follows the longer branch when there are several predecessors", () => {
    const all = board([
      { number: 1 },
      { number: 2 },
      { number: 3, after: [2] },
      { number: 4, after: [1, 3] },
    ]);
    expect(planOf(all).critical).toEqual(["t2", "t3", "t4"]);
  });

  it("is empty when nothing waits for anything", () => {
    expect(planOf(board([{ number: 1 }, { number: 2 }])).critical).toEqual([]);
  });
});

describe("cycles", () => {
  const all = board([
    { number: 1 },
    { number: 2, after: [1] },
    { number: 3, after: [2] },
    { number: 4 },
    { number: 5, parent: 4 },
    { number: 6, parent: 4, after: [5] },
    { number: 7, status: "cancelled" },
  ]);

  it("lets a task wait for one that does not wait for it", () => {
    expect(edgeRefusal("t4", "t3", all)).toBeUndefined();
    expect(edgeRefusal("t3", "t1", all)).toBeUndefined();
  });

  it("refuses an edge that closes a cycle, however long", () => {
    expect(edgeRefusal("t1", "t3", all)).toBe("cycle");
    expect(edgeRefusal("t1", "t2", all)).toBe("cycle");
  });

  it("counts waiting for a parent as waiting for its subtasks", () => {
    // 1 waits for 4, so for 5 and 6; then 5 waiting for 3 (which waits for 1) is a cycle.
    const more = board([
      { number: 1, after: [4] },
      { number: 2, after: [1] },
      { number: 3, after: [2] },
      { number: 4 },
      { number: 5, parent: 4 },
    ]);
    expect(edgeRefusal("t5", "t3", more)).toBe("cycle");
  });

  it("refuses the task itself, its parent, its subtask and a cancelled task", () => {
    expect(edgeRefusal("t1", "t1", all)).toBe("self");
    expect(edgeRefusal("t5", "t4", all)).toBe("tree");
    expect(edgeRefusal("t4", "t5", all)).toBe("tree");
    expect(edgeRefusal("t1", "t7", all)).toBe("cancelled");
  });
});

describe("a parent's progress", () => {
  it("has a segment per subtask in its state, finished first, and the counts", () => {
    const all = release();
    const progress = progressOf(all.find((t) => t.number === 4)!, all);
    expect(progress.segments.map((s) => s.segment)).toEqual([
      "done",
      "done",
      "in_review",
      "in_progress",
      "waiting",
    ]);
    expect(progress.counts).toEqual([
      { segment: "done", count: 2 },
      { segment: "in_review", count: 1 },
      { segment: "in_progress", count: 1 },
      { segment: "waiting", count: 1 },
    ]);
    expect([progress.done, progress.total]).toEqual([2, 5]);
    expect(progress.now?.title).toBe("跑回归测试");
    expect(progress.next?.title).toBe("发布公告");
  });

  it("leaves cancelled subtasks out", () => {
    const all = board([
      { number: 1 },
      { number: 2, parent: 1, status: "done" },
      { number: 3, parent: 1, status: "cancelled" },
    ]);
    const progress = progressOf(all[0]!, all);
    expect(progress.segments).toHaveLength(1);
    expect(progress.total).toBe(1);
  });
});

describe("what a task waits for", () => {
  it("names the one task left by its title, delivered or done", () => {
    const all = release();
    expect(waitSummary(all.find((t) => t.number === 9)!, all)).toEqual({
      kind: "one",
      title: "跑回归测试",
      requireDone: false,
    });
    const strict = board([
      { number: 1, title: "实现登录接口" },
      { number: 2, after: [[1, "done"]] },
    ]);
    expect(waitSummary(strict[1]!, strict)).toEqual({
      kind: "one",
      title: "实现登录接口",
      requireDone: true,
    });
  });

  it("counts them when it waits for several", () => {
    const all = board([
      { number: 1, status: "done" },
      { number: 2 },
      { number: 3 },
      { number: 4, after: [1, 2, 3] },
    ]);
    expect(waitSummary(all[3]!, all)).toEqual({
      kind: "many",
      total: 3,
      left: 2,
    });
  });

  it("says nothing for a task that waits for nothing or was stopped by a cancel", () => {
    const all = release();
    expect(waitSummary(all.find((t) => t.number === 2)!, all)).toBeUndefined();
    expect(waitSummary(all.find((t) => t.number === 11)!, all)).toBeUndefined();
  });

  it("counts the tasks it unlocks, and those it has let go", () => {
    const all = release();
    expect(releaseOf(all.find((t) => t.number === 8)!, all)).toEqual({
      waiting: 1,
      released: 0,
    });
    expect(releaseOf(all.find((t) => t.number === 7)!, all)).toEqual({
      waiting: 0,
      released: 1,
    });
  });
});

describe("the filter", () => {
  const all = release();

  it("finds by title or number", () => {
    expect(
      numbers(filterTasks(all, { q: "登录", who: null, under: null })),
    ).toEqual([2, 3]);
    expect(
      numbers(filterTasks(all, { q: "#9", who: null, under: null })),
    ).toEqual([9]);
    expect(
      numbers(filterTasks(all, { q: "11", who: null, under: null })),
    ).toEqual([11]);
  });

  it("narrows to an executor, and to a piece of work with what is under it", () => {
    expect(
      numbers(filterTasks(all, { q: "", who: "bo", under: null })),
    ).toEqual([11]);
    expect(
      numbers(filterTasks(all, { q: "", who: null, under: "t4" })),
    ).toEqual([4, 5, 6, 7, 8, 9]);
  });
});
