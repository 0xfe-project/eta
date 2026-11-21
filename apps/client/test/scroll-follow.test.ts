import { expect, test } from "nsh/test";
import {
  animateFollow,
  atBottom,
  distanceFromEnd,
  followNewRows,
  rowsAppended,
  wheelDistance,
  wheelIsNotch,
  wheelTarget,
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

test("a wheel event's distance is in points", () => {
  expect(wheelDistance({ delta: { y: 3 }, deltaMode: "lines" })).toBe(48);
  expect(wheelDistance({ delta: { y: 100 }, deltaMode: "points" })).toBe(100);
  expect(wheelDistance({ delta: { y: -2.5 }, deltaMode: "points" })).toBe(-2.5);
});

test("mouse notches glide and touchpad deltas follow the fingers", () => {
  expect(wheelIsNotch({ delta: { y: 3 }, deltaMode: "lines" })).toBe(true);
  expect(wheelIsNotch({ delta: { y: -200 }, deltaMode: "points" })).toBe(true);
  expect(wheelIsNotch({ delta: { y: 7.5 }, deltaMode: "points" })).toBe(false);
  expect(wheelIsNotch({ delta: { y: 130 }, deltaMode: "points" })).toBe(false);
  expect(wheelIsNotch({ delta: { y: 0 }, deltaMode: "points" })).toBe(false);
});

test("notches in one glide add up from where it aims", () => {
  const base = { offset: 100, max: 1000, last: 1000 };
  expect(wheelTarget({ ...base, now: 5000, distance: 100 })).toBe(200);
  expect(wheelTarget({ ...base, aim: 200, now: 1100, distance: 100 })).toBe(
    300,
  );
  // The glide ended: start again from where the list is.
  expect(wheelTarget({ ...base, aim: 200, now: 1300, distance: 100 })).toBe(
    200,
  );
});

test("a wheel target stays inside the content", () => {
  const base = { offset: 20, max: 500, last: 0, now: 5000 };
  expect(wheelTarget({ ...base, distance: -100 })).toBe(0);
  expect(wheelTarget({ ...base, offset: 450, distance: 100 })).toBe(500);
  expect(wheelTarget({ ...base, max: -5, distance: 100 })).toBe(0);
  // Before any scroll event the end is unknown.
  expect(
    wheelTarget({ ...base, max: Number.POSITIVE_INFINITY, distance: 100 }),
  ).toBe(120);
});
