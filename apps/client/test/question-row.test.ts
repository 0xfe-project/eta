import { expect, test } from "nsh/test";
import { questionRowIndex } from "../src/pages/chat/question-row";

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
