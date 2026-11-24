import { expect, test } from "nsh/test";
import { stepRows } from "../src/pages/tasks/task-steps";

const step = (
  id: string,
  status: "pending" | "in_progress" | "completed" | "cancelled",
) => ({
  id,
  content: `step ${id}`,
  status,
});

test("a task with no steps has no rows to show", () => {
  expect(stepRows(undefined)).toBeUndefined();
  expect(stepRows([])).toBeUndefined();
});

test("the rows keep the order of the plan and say how many are done", () => {
  const rows = stepRows([
    step("t1", "completed"),
    step("t2", "in_progress"),
    step("t3", "pending"),
    step("t4", "cancelled"),
  ])!;
  expect(rows.total).toBe(4);
  expect(rows.completed).toBe(1);
  expect(rows.rows.map((row) => row.id)).toEqual(["t1", "t2", "t3", "t4"]);
});

test("each step reads as the board status that looks like it", () => {
  const rows = stepRows([
    step("t1", "pending"),
    step("t2", "in_progress"),
    step("t3", "completed"),
    step("t4", "cancelled"),
  ])!;
  expect(rows.rows.map((row) => row.glyph)).toEqual([
    "todo",
    "in_progress",
    "done",
    "cancelled",
  ]);
});
