import type { Wheel } from "../src/components/rolling-number";
import { expect, open, test } from "nsh/test";
import { motion } from "../src/components/motion";
import {
  retarget,
  roll,
  turn,
  wheelsAt,
  wrap,
} from "../src/components/rolling-number";

const fixture = "./fixtures/rolling-number.tsx";
const frame = 1000 / 60;

/** The wheels rolled from `from` frame by frame until they rest, at most `until` ms. */
function run(wheels: Wheel[], from: number, until = 3000) {
  let now = from;
  let moving = true;
  while (moving && now - from < until) {
    const next = roll(wheels, now, now + frame);
    now += frame;
    wheels = next.wheels;
    moving = next.moving;
  }
  return { wheels, now, moving };
}

const digits = (wheels: Wheel[]) =>
  wheels.map((wheel) => wheel.roll.pos).join("");

test("a digit's offset from the wheel is the short way round the ring", () => {
  expect(wrap(1 - 9)).toBe(2);
  expect(wrap(9 - 1)).toBe(-2);
  expect(wrap(5)).toBe(-5);
  expect(wrap(0)).toBe(0);
});

test("a wheel turns the way the value went, never back the other way", () => {
  expect(turn(9, 0, true)).toBe(1);
  expect(turn(8, 1, true)).toBe(3);
  expect(turn(8, 1, false)).toBe(-7);
  expect(turn(0, 9, false)).toBe(-1);
  expect(turn(4, 4, true)).toBe(0);
});

test("38 → 41: the ones start first, the tens one stagger later, and it rests at 41", () => {
  const wheels = retarget(wheelsAt(38), 38, 41, 0);
  const [tens, ones] = wheels;
  expect(ones!.next).toBe(11);
  expect(tens!.next).toBe(4);
  expect(ones!.startAt).toBe(0);
  expect(tens!.startAt).toBe(motion.counter.stagger);
  roll(wheels, 0, frame);
  expect(ones!.roll.pos).toBeGreaterThan(8);
  expect(tens!.roll.pos).toBe(3);
  const rested = run(wheels, frame);
  expect(rested.moving).toBe(false);
  expect(digits(rested.wheels)).toBe("41");
});

test("38 → 39: the tens stay still, only the ones turn", () => {
  const wheels = retarget(wheelsAt(38), 38, 39, 0);
  const [tens] = wheels;
  roll(wheels, 0, frame);
  expect(tens!.roll).toEqual({ pos: 3, vel: 0 });
  expect(digits(run(wheels, frame).wheels)).toBe("39");
});

test("9 → 10: the ones turn up through 0 and the tens grow in from nothing", () => {
  const wheels = retarget(wheelsAt(9), 9, 10, 0);
  expect(wheels.map((wheel) => wheel.place)).toEqual([1, 0]);
  const [tens, ones] = wheels;
  expect(ones!.next).toBe(10);
  expect(tens!.presence.pos).toBe(0);
  const rested = run(wheels, 0);
  expect(digits(rested.wheels)).toBe("10");
  expect(tens!.presence.pos).toBe(1);
});

test("98 → 3: the wheels turn down and the tens shrink away", () => {
  const wheels = retarget(wheelsAt(98), 98, 3, 0);
  const [tens, ones] = wheels;
  expect(ones!.next).toBe(3);
  expect(tens!.next).toBe(0);
  roll(wheels, 0, frame);
  expect(ones!.roll.vel).toBeLessThan(0);
  const rested = run(wheels, frame);
  expect(rested.wheels.map((wheel) => wheel.place)).toEqual([0]);
  expect(digits(rested.wheels)).toBe("3");
});

test("a new value mid-turn keeps the wheel's speed and rests at the newest value", () => {
  let wheels = retarget(wheelsAt(38), 38, 41, 0);
  const ones = wheels[1]!;
  let now = 0;
  for (let i = 0; i < 6; i++) {
    roll(wheels, now, now + frame);
    now += frame;
  }
  const speed = ones.roll.vel;
  expect(speed).toBeGreaterThan(0);
  wheels = retarget(wheels, 41, 45, now);
  expect(ones.roll.vel).toBe(speed);
  roll(wheels, now, now + frame);
  expect(ones.roll.vel).toBeGreaterThan(speed);
  expect(digits(run(wheels, now + frame).wheels)).toBe("45");
});

test("the number rolls to each value it is set to", async () => {
  const app = await open(fixture, { width: 800, height: 300, clock: {} });
  const shown = () =>
    app
      .texts()
      .filter((text) => /^\d$/.test(text))
      .join("");
  expect(shown()).toBe("38");
  await app.press("label:Set 41");
  await app.clock!.runFor(2000);
  expect(shown()).toBe("41");
  await app.press("label:Set 10");
  await app.clock!.runFor(2000);
  expect(shown()).toBe("10");
  await app.press("label:Set 3");
  await app.clock!.runFor(2000);
  expect(shown()).toBe("3");
  await app.press("label:Set 120");
  await app.clock!.runFor(2000);
  expect(shown()).toBe("120");
});

test("with less motion asked for, the number lands on each new value", async () => {
  const app = await open(fixture, {
    width: 800,
    height: 300,
    clock: {},
    reducedMotion: true,
  });
  const shown = () =>
    app
      .texts()
      .filter((text) => /^\d$/.test(text))
      .join("");
  await app.press("label:Set 120");
  expect(shown()).toBe("120");
  await app.press("label:Set 9");
  expect(shown()).toBe("9");
});
