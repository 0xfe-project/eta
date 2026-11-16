import { expect, it } from "vitest";
import * as owner from "../src/session-owner";

const taskOfRun = (runId: string) => ({ r1: "t1" })[runId];
const originOf = (taskId: string) => ({ t1: "c1", t2: null })[taskId];
const conversation = (conversationId: string) => ({
  kind: "conversation",
  conversationId,
});
const task = (taskId?: string) => ({ kind: "task", taskId });

it.each([
  ["c1", conversation("c1"), "c1"],
  [owner.taskKey("t1"), task("t1"), "c1"],
  // A mentioned agent's session is the task's; the task is the first segment.
  [owner.mentionKey("t1", "a1"), task("t1"), "c1"],
  ["task:t1:a:b", task("t1"), "c1"],
  // A legacy key: its task is found through the run, or is unknown.
  [owner.sessionKeyOf({ id: "r1", sessionKey: null }), task("t1"), "c1"],
  ["task-run:gone", task(undefined), undefined],
  // A task made outside any conversation, and one that is gone.
  [owner.taskKey("t2"), task("t2"), undefined],
  [owner.taskKey("nope"), task("nope"), undefined],
  // A task id that looks like another prefix is still the task's.
  ["task:routine", task("routine"), undefined],
  [owner.routineKey("r1"), { kind: "routine", runId: "r1" }, undefined],
  ["routine:task:1", { kind: "routine", runId: "task:1" }, undefined],
  // Only a prefix at the very start counts.
  ...["my-task:1", "xroutine:1", " task:1", "Task:1", "task-runner"].map(
    (id) => [id, conversation(id), id] as const,
  ),
  [undefined, undefined, undefined],
] as const)("%s", (key, expected, counted) => {
  const found = owner.ownerOf(key, taskOfRun);
  expect(found).toEqual(expected);
  expect(owner.heldIn(key)).toBe(found?.kind ?? "conversation");
  expect(owner.taskOf(key, taskOfRun)).toBe(
    found?.kind === "task" ? found.taskId : undefined,
  );
  expect(owner.conversationOf(found, originOf)).toBe(counted);
});

it("keeps a run's recorded key, and reads a legacy key without a lookup", () => {
  expect(owner.sessionKeyOf({ id: "r1", sessionKey: "task:t1" })).toBe(
    "task:t1",
  );
  expect(owner.ownerOf("task-run:r1")).toEqual(task(undefined));
});
