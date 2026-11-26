import type { BoardTaskView } from "@eta/client-contracts";
import { expect, open, test } from "nsh/test";
import {
  dependentsOf,
  standaloneDependencyChains,
  stepOf,
} from "../src/pages/tasks/facts";

// The Plan view keeps one graph per plan and passes it on only when the plan's shape changed, so
// a push that moves nothing but a running task's tokens does not lay the plan out again. What a
// card says must still be the task of now, and a change of shape must still move the cards.
const open_ = (width = 1440) =>
  open("./fixtures/plan-board.tsx", {
    width,
    height: 900,
    locale: "en-US",
  });

/** Which column a card is drawn in, from the left, among the cards named. */
function columns(
  app: Awaited<ReturnType<typeof open_>>,
  titles: string[],
): number[] {
  const lefts = titles.map((title) => app.layout(`label:${title}`)?.x ?? -1);
  const distinct = [...new Set(lefts)].sort((a, b) => a - b);
  return lefts.map((left) => distinct.indexOf(left));
}

test("each subtask is in its step; orphan tasks are hidden in plan view", async () => {
  const app = await open_();
  await app.waitFor("text:Ship the login page");
  expect(
    columns(app, [
      "Build the login API",
      "Write the login tests",
      "Wire up the login form",
    ]),
  ).toEqual([0, 1, 0]);
  expect(app.shows("text:Not part of anything")).toBe(false);
  expect(app.shows("label:Tidy the changelog")).toBe(false);
});

test("a push that changes no step keeps the cards and shows what changed", async () => {
  const app = await open_();
  await app.waitFor("text:Ship the login page");
  await app.press("label:push again");
  await app.press("label:rename");
  await app.waitFor("label:Build the sign-in API");
  expect(app.shows("label:Build the login API")).toBe(false);
  expect(
    columns(app, [
      "Build the sign-in API",
      "Write the login tests",
      "Wire up the login form",
    ]),
  ).toEqual([0, 1, 0]);
});

test("a new wait moves the task to the step after the one it waits for", async () => {
  const app = await open_();
  await app.waitFor("text:Ship the login page");
  await app.press("label:wait");
  expect(
    columns(app, [
      "Build the login API",
      "Write the login tests",
      "Wire up the login form",
    ]),
  ).toEqual([0, 1, 2]);
  expect(app.texts()).toContain("Step 3");
});

test("a cancelled task leaves the plan", async () => {
  const app = await open_();
  await app.waitFor("text:Ship the login page");
  await app.press("label:cancel");
  await app.waitUntil(() => !app.shows("label:Write the login tests"));
  expect(app.texts()).not.toContain("Step 2");
});

const task = (id: string, change: Partial<BoardTaskView> = {}) =>
  ({ id, number: 0, title: id, status: "todo", ...change }) as BoardTaskView;

test("the tasks that wait for one are those not over, each once", () => {
  const tasks = [
    task("a"),
    task("b", { dependsOn: [{ taskId: "a" }, { taskId: "a" }] } as never),
    task("c", { dependsOn: [{ taskId: "a" }], status: "done" } as never),
    task("d", { dependsOn: [{ taskId: "a" }], status: "cancelled" } as never),
    task("e", { dependsOn: [{ taskId: "b" }] } as never),
  ];
  expect(dependentsOf(tasks[0]!, tasks).map((t) => t.id)).toEqual(["b"]);
  expect(dependentsOf(tasks[1]!, tasks).map((t) => t.id)).toEqual(["e"]);
  expect(dependentsOf(tasks[4]!, tasks)).toEqual([]);
  // a new list is a new board
  const next = [
    ...tasks.slice(0, 2),
    task("f", { dependsOn: [{ taskId: "a" }] } as never),
  ];
  expect(dependentsOf(tasks[0]!, next).map((t) => t.id)).toEqual(["b", "f"]);
});

test("a subtask's step counts among its siblings only, and a cycle is cut", () => {
  const tasks = [
    task("p"),
    task("a", { parentId: "p" }),
    task("b", { parentId: "p", dependsOn: [{ taskId: "a" }] } as never),
    task("c", {
      parentId: "p",
      dependsOn: [{ taskId: "b" }, { taskId: "x" }],
    } as never),
    task("x", { parentId: "q", dependsOn: [{ taskId: "y" }] } as never),
    task("y", { parentId: "q", dependsOn: [{ taskId: "x" }] } as never),
  ];
  expect(tasks.map((t) => stepOf(t, tasks))).toEqual([
    undefined,
    1,
    2,
    3,
    3,
    2,
  ]);
  // a subtask whose siblings are not in the list is in the first step
  expect(stepOf(task("z", { parentId: "gone" }), tasks)).toBe(1);
});

test("top-level dependency chains render with columns while isolated tasks stay hidden", async () => {
  const app = await open_();
  await app.press("label:chains");
  await app.waitFor("label:Cut release");
  expect(columns(app, ["Fix sync", "Ship CLI", "Cut release"])).toEqual([
    0, 0, 1,
  ]);
  expect(app.shows("text:#440 · 3 tasks · 2 steps to go")).toBe(true);
  expect(app.shows("label:Tidy the changelog")).toBe(false);
  await app.press("label:Open task #440");
  await app.waitFor("text:opened:t440");
});

test("completed standalone chains collapse behind a toggle when active chains exist and expand by default otherwise", async () => {
  const app = await open_();
  await app.press("label:chains");
  await app.waitFor("label:Cut release");
  expect(app.shows("label:Completed · 1")).toBe(true);
  expect(app.shows("label:Draft spec")).toBe(false);
  await app.press("label:Completed · 1");
  await app.waitFor("label:Draft spec");
  expect(app.shows("label:Approve spec")).toBe(true);
  expect(app.shows("text:#101 · 2 tasks · all done")).toBe(true);

  const onlyCompleted = await open_();
  await onlyCompleted.press("label:completed only");
  await onlyCompleted.waitFor("label:Draft spec");
  expect(onlyCompleted.shows("label:Approve spec")).toBe(true);
  expect(onlyCompleted.shows("text:#101 · 2 tasks · all done")).toBe(true);
  await onlyCompleted.press("label:Completed · 1");
  await onlyCompleted.waitUntil(() => !onlyCompleted.shows("label:Draft spec"));
});

test("cancelling one task in a two-task standalone chain removes the chain", async () => {
  const app = await open_();
  await app.press("label:two-task chain");
  await app.waitFor("label:Run migration");
  expect(columns(app, ["Prepare migration", "Run migration"])).toEqual([0, 1]);
  await app.press("label:cancel chain task");
  await app.waitFor("text:No plans yet");
  expect(app.shows("label:Run migration")).toBe(false);
});

test("empty state renders on desktop and tablet when zero plans exist", async () => {
  const desktop = await open_();
  await desktop.press("label:empty");
  await desktop.waitFor("text:No plans yet");
  expect(
    desktop.shows(
      "text:Tasks with subtasks or dependencies appear here as step-by-step plans.",
    ),
  ).toBe(true);
  expect(desktop.shows("label:Tidy the changelog")).toBe(false);

  const tablet = await open_(820);
  await tablet.press("label:tablet");
  await tablet.waitFor(
    "text:Drag a task’s right edge onto another to make that one wait for it",
  );
  await tablet.press("label:empty");
  await tablet.waitFor("text:No plans yet");
  expect(
    tablet.shows(
      "text:Tasks with subtasks or dependencies appear here as step-by-step plans.",
    ),
  ).toBe(true);
  expect(tablet.shows("label:Tidy the changelog")).toBe(false);
  expect(
    tablet.shows(
      "text:Drag a task’s right edge onto another to make that one wait for it",
    ),
  ).toBe(false);
});

test("standaloneDependencyChains groups connected components, picks terminals, and filters cleanly", () => {
  const item = (
    id: string,
    number: number,
    change: Partial<BoardTaskView> = {},
  ) =>
    ({
      id,
      number,
      title: `Task ${number}`,
      status: "todo",
      ...change,
    }) as BoardTaskView;

  // Release chain #435/#437/#438 -> #440, plus completed chain #10/#11, plus isolated #99,
  // plus a parent #1 and its subtasks #2/#3, plus a subtask #50 whose parent is absent.
  const items = [
    item("p1", 1, { subtasks: { total: 2, done: 0 } }),
    item("s2", 2, { parentId: "p1" }),
    item("s3", 3, { parentId: "p1", dependsOn: [{ taskId: "s2" }] } as never),
    item("t435", 435, { status: "in_review" }),
    item("t437", 437, { status: "in_progress" }),
    item("t438", 438, { status: "done" }),
    item("t440", 440, {
      dependsOn: [{ taskId: "t435" }, { taskId: "t437" }, { taskId: "t438" }],
    } as never),
    item("t10", 10, { status: "done" }),
    item("t11", 11, {
      status: "done",
      dependsOn: [{ taskId: "t10" }],
    } as never),
    item("t99", 99),
    item("s50", 50, { parentId: "missing", status: "done" }),
    item("s51", 51, {
      parentId: "missing",
      dependsOn: [{ taskId: "s50" }, { taskId: "s2" }],
    } as never),
  ];

  const parentIds = new Set(["p1"]);
  const grouped = standaloneDependencyChains(items, parentIds);
  expect(grouped.active.map((c) => c.terminal.number)).toEqual([440, 51]);
  expect(grouped.active[0]!.tasks.map((t) => t.number)).toEqual([
    435, 437, 438, 440,
  ]);
  expect(grouped.active[1]!.tasks.map((t) => t.number)).toEqual([50, 51]);
  expect(grouped.completed.map((c) => c.terminal.number)).toEqual([11]);
  expect(grouped.completed[0]!.tasks.map((t) => t.number)).toEqual([10, 11]);

  // Tie-break terminal selection by highest number when multiple tasks share deepest level.
  const fanOut = standaloneDependencyChains([
    item("a", 10),
    item("b", 11, { dependsOn: [{ taskId: "a" }] } as never),
    item("c", 12, { dependsOn: [{ taskId: "a" }] } as never),
  ]);
  expect(fanOut.active[0]!.terminal.number).toBe(12);

  // Cancelling a task in a 2-task chain or middle node in A -> B -> C removes the chain.
  const twoCancelled = standaloneDependencyChains([
    item("a", 1, { status: "cancelled" }),
    item("b", 2, { dependsOn: [{ taskId: "a" }] } as never),
  ]);
  expect(twoCancelled.active).toEqual([]);
  expect(twoCancelled.completed).toEqual([]);

  const middleCancelled = standaloneDependencyChains([
    item("a", 1),
    item("b", 2, {
      status: "cancelled",
      dependsOn: [{ taskId: "a" }],
    } as never),
    item("c", 3, { dependsOn: [{ taskId: "b" }] } as never),
  ]);
  expect(middleCancelled.active).toEqual([]);
  expect(middleCancelled.completed).toEqual([]);

  // Handles cycles and ignores self-loops.
  const cycleAndLoop = standaloneDependencyChains([
    item("self", 1, { dependsOn: [{ taskId: "self" }] } as never),
    item("x", 20, { dependsOn: [{ taskId: "y" }] } as never),
    item("y", 21, { dependsOn: [{ taskId: "x" }] } as never),
  ]);
  expect(cycleAndLoop.active.length).toBe(1);
  expect(cycleAndLoop.active[0]!.tasks.map((t) => t.number)).toEqual([20, 21]);
});
