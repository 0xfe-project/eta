import { expect, test } from "nsh/test";
import {
  questionRowIndex,
  questionSource,
} from "../src/pages/chat/question-row";

const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

test("a question is found on the row of its reply", () => {
  expect(questionRowIndex(rows, "a")).toBe(0);
  expect(questionRowIndex(rows, "c")).toBe(2);
});

test("a question without a reply, or with one not loaded, has no row", () => {
  expect(questionRowIndex(rows, null)).toBeUndefined();
  expect(questionRowIndex(rows, "z")).toBeUndefined();
  expect(questionRowIndex([], "a")).toBeUndefined();
});

const tasks = [
  { id: "t1", runs: [{ sessionId: null }, { sessionId: "s-task" }] },
  { id: "t2", runs: [] },
];

test("a question on a loaded reply row is sourced from that row", () => {
  expect(
    questionSource({ replyId: "b", sessionId: "s-task" }, rows, tasks),
  ).toEqual({ kind: "row", index: 1 });
});

test("a question of a task run is sourced from the task", () => {
  expect(
    questionSource({ replyId: null, sessionId: "s-task" }, rows, tasks),
  ).toEqual({ kind: "task", taskId: "t1" });
  expect(
    questionSource({ replyId: "z", sessionId: "s-task" }, rows, tasks),
  ).toEqual({ kind: "task", taskId: "t1" });
});

test("a question with no loaded row and no task has no source", () => {
  expect(
    questionSource({ replyId: null, sessionId: "s-other" }, rows, tasks),
  ).toBeUndefined();
  expect(
    questionSource({ replyId: "z", sessionId: "s-other" }, [], []),
  ).toBeUndefined();
});
