import type { Task } from "@/queries/tasks";
import { describe, expect, it } from "@rstest/core";
import { pickOptions, stepIfMade } from "./task-pick";
import { parseSplit, splitBatch, stepSizes } from "./task-split";
import { board, release } from "./task-tree-fixture";

// The one picker of tasks (a dependency, a parent) and "split into subtasks": what they offer and
// what they send, read off the list as the host would rule.

const numbers = (options: { task: Task }[]) =>
  options.map((o) => o.task.number);
const noProject = () => undefined;

describe("the picker", () => {
  it("lists the same piece of work first, and greys what waits for this task as a cycle", () => {
    // #3 is a step of the release; #12, outside it, waits for #3. #3 picking a dependency.
    const all = board([
      { number: 4, title: "发布 v1.0", status: "in_progress" },
      { number: 5, status: "done", parent: 4 },
      { number: 6, status: "done", parent: 4 },
      { number: 7, status: "in_review", parent: 4, after: [5, 6] },
      { number: 8, status: "in_progress", parent: 4, after: [5, 6] },
      { number: 9, parent: 4, after: [8, 7] },
      { number: 3, title: "接入前端登录页", parent: 4 },
      { number: 2, title: "实现登录接口", status: "in_progress" },
      { number: 12, title: "端到端冒烟测试", after: [3] },
    ]);
    const options = pickOptions({
      mode: "dependsOn",
      subject: { id: "t3", parentId: "t4" },
      all,
      projectOf: noProject,
      projectId: undefined,
    });
    // The release's own first (its parent greyed, at the end of them), then the rest; never itself.
    expect(numbers(options).slice(0, 6)).toEqual([5, 6, 7, 8, 9, 4]);
    expect(numbers(options)).not.toContain(3);
    const twelve = options.find((o) => o.task.number === 12)!;
    expect(twelve).toMatchObject({ same: false, refusal: "cycle" });
    // Greyed ones go to the end of their group.
    expect(numbers(options).at(-1)).toBe(12);
    // Its parent is its own line: not a dependency.
    expect(options.find((o) => o.task.number === 4)!.refusal).toBe("tree");
  });

  it("finds by title or number, and marks another project's tasks", () => {
    const all = release();
    const projectOf = (t: Task) => (t.number === 2 ? "other" : "here");
    const byTitle = pickOptions({
      mode: "dependsOn",
      subject: { parentId: null },
      all,
      query: "登录",
      projectOf,
      projectId: "here",
    });
    expect(numbers(byTitle).sort()).toEqual([2, 3]);
    expect(byTitle.find((o) => o.task.number === 2)!.otherProject).toBe(true);
    expect(byTitle.find((o) => o.task.number === 3)!.otherProject).toBe(false);
    const byNumber = pickOptions({
      mode: "dependsOn",
      subject: { parentId: null },
      all,
      query: "#8",
      projectOf,
      projectId: "here",
    });
    expect(numbers(byNumber)).toEqual([8]);
  });

  it("offers as a parent only what is not the task or under it, nor cancelled", () => {
    const all = release();
    const options = pickOptions({
      mode: "parent",
      subject: { id: "t4", parentId: null },
      all,
      projectOf: noProject,
      projectId: undefined,
    });
    // #5–#9 are under #4, #10 is cancelled.
    expect(numbers(options).sort((a, b) => a - b)).toEqual([2, 3, 11]);
  });

  it("greys a parent that would make a new task wait for itself", () => {
    // #2 waits for #1; a new task that #1… cannot be: a new task waiting for #2, put under #1,
    // would wait for what #2 waits for — its own parent's work.
    const all = board([{ number: 1 }, { number: 2, after: [1] }]);
    const options = pickOptions({
      mode: "parent",
      subject: { parentId: null, dependsOn: ["t2"] },
      all,
      projectOf: noProject,
      projectId: undefined,
    });
    expect(options.find((o) => o.task.number === 1)!.refusal).toBe("cycle");
    expect(options.find((o) => o.task.number === 2)!.refusal).toBe("cycle");
  });

  it("says which step a new subtask lands on", () => {
    const all = release();
    expect(stepIfMade({ parentId: "t4", dependsOn: [] }, all)).toBe(1);
    expect(stepIfMade({ parentId: "t4", dependsOn: ["t9"] }, all)).toBe(4);
    expect(stepIfMade({ parentId: "t4", dependsOn: ["t8"] }, all)).toBe(3);
    expect(stepIfMade({ parentId: null }, all)).toBeUndefined();
  });
});

describe("splitting into subtasks", () => {
  const text = "整理变更日志\n更新用户文档\n→ 跑回归测试\n→ 发布公告";

  it("reads side by side lines as one step and an arrow as the next", () => {
    const lines = parseSplit(text);
    expect(lines.map((l) => [l.title, l.step, l.after])).toEqual([
      ["整理变更日志", 1, []],
      ["更新用户文档", 1, []],
      ["跑回归测试", 2, [0, 1]],
      ["发布公告", 3, [2]],
    ]);
    expect(stepSizes(lines)).toEqual([2, 1, 1]);
  });

  it("puts a line without an arrow beside the one above it, and skips blanks", () => {
    const lines = parseSplit("A\n\n-> B\nC\n  →   \n→ D");
    expect(lines.map((l) => [l.title, l.step, l.after])).toEqual([
      ["A", 1, []],
      ["B", 2, [0]],
      ["C", 2, [0]],
      ["D", 3, [1, 2]],
    ]);
    // An arrow on the first line has nothing to wait for.
    expect(parseSplit("→ A\nB").map((l) => l.step)).toEqual([1, 1]);
  });

  it("sends the lines under an existing task, or under a new one made in the same write", () => {
    const lines = parseSplit(text);
    expect(splitBatch(lines, "ada")).toEqual([
      { title: "整理变更日志", assignee: "ada" },
      { title: "更新用户文档", assignee: "ada" },
      { title: "跑回归测试", assignee: "ada", after: [0, 1] },
      { title: "发布公告", assignee: "ada", after: [2] },
    ]);
    expect(splitBatch(lines, "ada", { title: "发布 v1.0" })).toEqual([
      { title: "发布 v1.0", description: undefined, assignee: "ada" },
      { title: "整理变更日志", assignee: "ada", under: 0 },
      { title: "更新用户文档", assignee: "ada", under: 0 },
      { title: "跑回归测试", assignee: "ada", after: [1, 2], under: 0 },
      { title: "发布公告", assignee: "ada", after: [3], under: 0 },
    ]);
  });
});
