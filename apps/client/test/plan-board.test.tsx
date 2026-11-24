import { expect, open, test } from "nsh/test";
import type { BoardTaskView } from "@eta/client-contracts";
import { dependentsOf, stepOf } from "../src/pages/tasks/facts";

// The Plan view keeps one graph per plan and passes it on only when the plan's shape changed, so
// a push that moves nothing but a running task's tokens does not lay the plan out again. What a
// card says must still be the task of now, and a change of shape must still move the cards.
const open_ = () =>
  open("./fixtures/plan-board.tsx", {
    width: 1440,
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

test("each subtask is in its step, and a task under nothing has its own frame", async () => {
  const app = await open_();
  await app.waitFor("text:Ship the login page");
  expect(
    columns(app, [
      "Build the login API",
      "Write the login tests",
      "Wire up the login form",
    ]),
  ).toEqual([0, 1, 0]);
  expect(app.shows("text:Not part of anything")).toBe(true);
  expect(app.shows("label:Tidy the changelog")).toBe(true);
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
