import type { TextStyle } from "nsh";
import type { light, TextVariant } from "./theme";
import { cleanup, effect, reduceMotion, signal, untracked, View } from "nsh";
import { motion } from "./motion";
import { Label } from "./text";
import { textFaces } from "./theme";

// The spring is integrated in steps of at most this many seconds, and a frame counts for at most
// `longestFrame` seconds: after a stall the wheels go on from where they were instead of jumping.
const substep = 1 / 240;
const longestFrame = 0.05;
// A wheel is at rest once it is this close to its target, in digits, and this slow, in digits a
// second.
const restDistance = 0.002;
const restSpeed = 0.02;

/** `x` brought into [-5, 5): how far a digit is from a wheel's position, the short way round. */
export function wrap(x: number) {
  return ((((x + 5) % 10) + 10) % 10) - 5;
}

const mod10 = (x: number) => ((x % 10) + 10) % 10;

/** How many digits a wheel turns from `from` to `to`: forward (up) or backward (down) round the
 * ring, never the other way; 0 when they are the same. */
export function turn(from: number, to: number, up: boolean) {
  const forward = mod10(to - from);
  if (forward === 0) return 0;
  return up ? forward : forward - 10;
}

/** A value springing to its target: `period` in milliseconds, critically damped, so it never
 * passes it. */
interface Spring {
  pos: number;
  vel: number;
}

function step(spring: Spring, target: number, period: number, dt: number) {
  const omega = (2 * Math.PI) / (period / 1000);
  spring.vel +=
    (-omega * omega * (spring.pos - target) - 2 * omega * spring.vel) * dt;
  spring.pos += spring.vel * dt;
}

const resting = (spring: Spring, target: number) =>
  Math.abs(spring.pos - target) < restDistance &&
  Math.abs(spring.vel) < restSpeed;

/** One digit of a rolling number: the wheel at `place` (0 for the ones), turning to `target` (a
 * digit count that keeps growing or shrinking as the wheel turns, not only 0–9) from `startAt`
 * on, and its presence (its width and opacity, 0 to 1) springing to `present`. */
export interface Wheel {
  place: number;
  roll: Spring;
  target: number;
  /** The target it turns to once `startAt` comes, staggered from the ones up. */
  next: number;
  startAt: number;
  presence: Spring;
  present: 0 | 1;
}

/** Wheels showing `value` at rest, the highest place first. */
export function wheelsAt(value: number): Wheel[] {
  const digits = String(value);
  return [...digits].map((digit, index) => {
    const d = Number(digit);
    return {
      place: digits.length - 1 - index,
      roll: { pos: d, vel: 0 },
      target: d,
      next: d,
      startAt: 0,
      presence: { pos: 1, vel: 0 },
      present: 1,
    };
  });
}

/**
 * The wheels turning from `from` to `to` at `now`, the highest place first: every digit that
 * changes turns the way the value went (up when it grew, down when it shrank) straight to its
 * new digit, the ones first and each higher one `motion.counter.stagger` later. A wheel turning
 * keeps its position and speed and only changes where it is going. A place `to` gains comes in
 * from 0 as it grows; one it loses turns back to 0 as it shrinks, and stays in the list until
 * `roll` drops it.
 */
export function retarget(
  wheels: Wheel[],
  from: number,
  to: number,
  now: number,
): Wheel[] {
  const up = to > from;
  const digits = String(to);
  const byPlace = new Map(wheels.map((wheel) => [wheel.place, wheel]));
  const places = Math.max(digits.length, ...wheels.map((w) => w.place + 1));
  const next: Wheel[] = [];
  let rank = 0;
  for (let place = 0; place < places; place++) {
    const wheel = byPlace.get(place) ?? {
      place,
      roll: { pos: 0, vel: 0 },
      target: 0,
      next: 0,
      startAt: 0,
      presence: { pos: 0, vel: 0 },
      present: 1 as const,
    };
    const shown = place < digits.length;
    const digit = shown ? Number(digits[digits.length - 1 - place]) : 0;
    wheel.present = shown ? 1 : 0;
    const steps = turn(mod10(Math.round(wheel.next)), digit, up);
    if (steps !== 0) {
      wheel.next += steps;
      wheel.startAt = now + rank * motion.counter.stagger;
      rank++;
    }
    next.unshift(wheel);
  }
  return next;
}

/** The wheels advanced from `last` to `now` (milliseconds), and whether any still moves; a wheel
 * whose presence came to 0 is dropped. */
export function roll(wheels: Wheel[], last: number, now: number) {
  const dt = Math.min(Math.max(now - last, 0) / 1000, longestFrame);
  const steps = Math.ceil(dt / substep);
  let moving = false;
  const kept = wheels.filter((wheel) => {
    if (now >= wheel.startAt) wheel.target = wheel.next;
    for (let i = 0; i < steps; i++) {
      step(wheel.roll, wheel.target, motion.counter.period, dt / steps);
      step(wheel.presence, wheel.present, motion.counter.presence, dt / steps);
    }
    if (resting(wheel.roll, wheel.target) && wheel.target === wheel.next) {
      const digit = mod10(Math.round(wheel.target));
      wheel.roll = { pos: digit, vel: 0 };
      wheel.target = digit;
      wheel.next = digit;
    } else moving = true;
    if (resting(wheel.presence, wheel.present))
      wheel.presence = { pos: wheel.present, vel: 0 };
    else moving = true;
    return wheel.present === 1 || wheel.presence.pos > 0;
  });
  return { wheels: kept, moving };
}

/** What a wheel draws: its position and presence, and whether it is at rest. */
interface WheelFrame {
  place: number;
  pos: number;
  presence: number;
  still: boolean;
}

const frameOf = (wheel: Wheel): WheelFrame => ({
  place: wheel.place,
  pos: wheel.roll.pos,
  presence: wheel.presence.pos,
  still:
    wheel.roll.vel === 0 &&
    wheel.target === wheel.next &&
    wheel.roll.pos === wheel.target &&
    wheel.presence.vel === 0 &&
    wheel.presence.pos === wheel.present,
});

const ring = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * A non-negative whole number whose digits roll like a counter's when it changes: each digit is
 * a 0–9 wheel springing to its new digit, the way the value went, the ones first. A digit the
 * number gains grows in from the left, one it loses shrinks away. Digits fade as they pass the
 * wheel's edges, `motion.counter.fade` em beyond the line. It first shows at its value, without
 * turning; with less motion asked for, it changes at once. Every digit is one monospace character
 * wide, so the number's width moves only as digits come and go.
 *
 * It is hidden from assistive technologies: the view around it labels the whole value.
 */
export function RollingNumber(props: {
  value: number;
  /** The text's role in the type scale (`caption`). */
  variant?: TextVariant;
  tone?: keyof typeof light;
}) {
  const type = textFaces();
  const variant = () => props.variant ?? "caption";
  const face = () => type(variant());
  const glyph = (digit: () => number, style?: TextStyle) => (
    <Label variant={variant()} tone={props.tone} mono style={style}>
      {String(digit())}
    </Label>
  );

  let wheels = wheelsAt(untracked(() => props.value));
  let shown = untracked(() => props.value);
  let last = 0;
  let frame: number | undefined;
  const frames = signal(wheels.map(frameOf));
  const width = signal<number | undefined>(undefined);

  const tick = () => {
    const now = performance.now();
    const next = roll(wheels, last, now);
    last = now;
    wheels = next.wheels;
    frames.set(wheels.map(frameOf));
    frame = next.moving ? requestAnimationFrame(tick) : undefined;
  };

  effect(() => {
    const value = props.value;
    if (value === shown) return;
    const from = shown;
    shown = value;
    if (reduceMotion()) {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      wheels = wheelsAt(value);
      frames.set(wheels.map(frameOf));
      return;
    }
    const now = performance.now();
    wheels = retarget(wheels, from, value, now);
    if (frame === undefined) {
      last = now;
      frame = requestAnimationFrame(tick);
    }
  });
  cleanup(() => cancelAnimationFrame(frame));

  // A digit fades out once it is half a line plus `fade` em from the middle, in lines.
  const reach = () => 0.5 + (motion.counter.fade * face().size) / face().line;
  const overhang = () => motion.counter.fade * face().size;

  return (
    <View
      accessibilityElementsHidden
      style={{ flexDirection: "row", flexShrink: 0 }}
    >
      <Each of={frames()} key={(wheel) => wheel.place}>
        {(wheel) => (
          <View
            onLayout={(e) => {
              // A whole wheel is one digit wide: the width a coming or going one grows from or
              // shrinks to.
              if (wheel().presence === 1) width.set(e.bounds.size.width);
            }}
            style={{
              // The wheel reaches `overhang` above and below the line, for the digits fading
              // past its edges, without making the line taller.
              marginVertical: -overhang(),
              paddingVertical: overhang(),
              overflow: "hidden",
              ...(wheel().presence < 1 && width() !== undefined
                ? {
                    width: wheel().presence * width()!,
                    opacity: wheel().presence,
                  }
                : {}),
            }}
          >
            <If
              when={!wheel().still}
              else={glyph(() => Math.round(wheel().pos) % 10)}
            >
              {glyph(() => 0, { opacity: 0 })}
              <Each
                of={ring.filter(
                  (digit) => Math.abs(wrap(digit - wheel().pos)) < reach(),
                )}
              >
                {(digit) => {
                  const offset = () => wrap(digit() - wheel().pos);
                  return (
                    <View
                      style={{
                        position: "absolute",
                        top: overhang(),
                        left: 0,
                        opacity: Math.min(
                          1,
                          Math.max(0, 1 - Math.abs(offset()) / reach()),
                        ),
                        transform: [{ translateY: offset() * face().line }],
                      }}
                    >
                      {glyph(digit)}
                    </View>
                  );
                }}
              </Each>
            </If>
          </View>
        )}
      </Each>
    </View>
  );
}
