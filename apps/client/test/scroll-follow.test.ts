import { expect, test } from "nsh/test";
import {
  animateFollow,
  atBottom,
  distanceFromEnd,
  followNewRows,
  rowsAppended,
} from "../src/pages/chat/scroll-follow";

test("distance from the end comes from the scroll event", () => {
  expect(
    distanceFromEnd({
      offset: { y: 600 },
      contentSize: { height: 1000 },
      size: { height: 400 },
    }),
  ).toBe(0);
  expect(
    distanceFromEnd({
      offset: { y: 100 },
      contentSize: { height: 1000 },
      size: { height: 400 },
    }),
  ).toBe(500);
});

test("near the end counts as the bottom, further up does not", () => {
  expect(atBottom(0)).toBe(true);
  expect(atBottom(40)).toBe(true);
  expect(atBottom(41)).toBe(false);
});

test("only rows added after the last one count as new", () => {
  expect(rowsAppended(["a", "b"], ["a", "b", "c"])).toBe(true);
  expect(rowsAppended([], ["a", "b"])).toBe(false);
  expect(rowsAppended(["a", "b"], ["x", "y", "z"])).toBe(false);
  expect(rowsAppended(["b", "c"], ["a", "b", "c"])).toBe(false);
  expect(rowsAppended(["a", "b"], ["a", "b"])).toBe(false);
});

test("a reader who scrolled up is not pulled back", () => {
  expect(followNewRows(["a"], ["a", "b"], true)).toBe(true);
  expect(followNewRows(["a"], ["a", "b"], false)).toBe(false);
  expect(followNewRows([], ["a", "b"], true)).toBe(false);
});

test("reduced motion turns the animation off", () => {
  expect(animateFollow(false)).toBe(true);
  expect(animateFollow(true)).toBe(false);
});
