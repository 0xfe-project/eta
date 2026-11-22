import { expect, test } from "nsh/test";
import {
  animateFollow,
  wheelDistance,
  wheelIsNotch,
  wheelScroll,
  wheelTarget,
} from "../src/components/scroll-follow";

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

test("a glide area scrolls to where mouse notches add up, within its end", () => {
  const calls: [number, boolean][] = [];
  const glide = wheelScroll((offset, animated) =>
    calls.push([offset, animated]),
  );
  glide.onScroll({
    offset: { y: 0 },
    contentSize: { height: 1000 },
    size: { height: 800 },
  });
  const notch = { delta: { x: 0, y: 100 }, deltaMode: "points" } as never;
  glide.onWheel(notch);
  glide.onWheel(notch);
  glide.onWheel(notch);
  expect(calls).toEqual([
    [100, true],
    [200, true],
    [200, true],
  ]);
});

test("a glide area follows touchpad deltas without animating", () => {
  const calls: [number, boolean][] = [];
  const glide = wheelScroll((offset, animated) =>
    calls.push([offset, animated]),
  );
  glide.onWheel({ delta: { x: 0, y: 7.5 }, deltaMode: "points" } as never);
  expect(calls).toEqual([[7.5, false]]);
});

test("a glide area leaves sideways wheels alone", () => {
  const calls: [number, boolean][] = [];
  const glide = wheelScroll((offset, animated) =>
    calls.push([offset, animated]),
  );
  glide.onWheel({ delta: { x: 100, y: 0 }, deltaMode: "points" } as never);
  expect(calls).toEqual([]);
});
