import type { Easing, MotionSpec, ViewStyle } from "nsh";
import { createMotion, signal } from "nsh";
import { space } from "./tokens";

// The app's motion, said once (#378, #379 and #380 share this file): every duration, curve and
// distance something moves or waits by is here, beside what it is for. Durations are
// milliseconds, distances points. When the user asks for less motion, NSH lands every motion
// where it ends at once: nothing here plays then.

export const motion = {
  /** A wait shorter than this shows nothing: a spinner or a skeleton appears only once a wait
   * has lasted this long (#380). */
  reveal: 150,
  /** A spinner or a skeleton that appeared stays at least this long, so it never flashes. */
  minShown: 300,
  /** One turn of a spinner, or of a button's own icon while its action runs. */
  spin: 800,
  /** A dialog, sheet or drawer coming in (`Modal`): the phone's and the larger windows'. The
   * phone's is longer, as the spec of #379 asks for sheets (350–500 ms), the others about 2/3. */
  dialogIn: { phone: 360, window: 240 },
  /** The same going out: a little quicker than it came. */
  dialogOut: { phone: 260, window: 180 },
  /** A page pushed in on the phone (a conversation over the chat list, a task, a page of More),
   * or the one under it coming back. */
  pageIn: 320,
  /** How far a dialog, sheet, drawer or page travels while it fades. */
  shift: space[16],
  /** In and out of a screen: `cubic-bezier(.32,.72,0,1)`, the spec's opening curve. */
  open: [0.32, 0.72, 0, 1] as Easing,
  /** Going away: eases in, so it leaves quickly once it starts. */
  close: [0.32, 0, 0.67, 0] as Easing,
} as const;

/** Where something comes from as it fades in: below (a dialog, a sheet), the trailing edge (a
 * drawer, a page pushed in) or the leading edge (the page under it, coming back). */
export type MotionFrom = "below" | "end" | "start";

/** The channel `from` moves along and where it starts on it. */
function away(from: MotionFrom) {
  const channel = from === "below" ? "translateY" : "translateX";
  return [channel, from === "start" ? -motion.shift : motion.shift] as const;
}

/** Fades in while moving `motion.shift` into place from `from`. */
export function fadeIn(from: MotionFrom, duration: number): MotionSpec {
  const [channel, start] = away(from);
  return {
    keyframes: { opacity: [0, 1], [channel]: [start, 0] },
    duration,
    easing: motion.open,
  };
}

/** The way back: fades out while moving toward `from`. */
export function fadeOut(from: MotionFrom, duration: number): MotionSpec {
  const [channel, end] = away(from);
  return {
    keyframes: { opacity: [1, 0], [channel]: [0, end] },
    duration,
    easing: motion.close,
  };
}

/** A backdrop behind a dialog fading in or out. */
export function fade(to: 0 | 1, duration: number): MotionSpec {
  return {
    keyframes: { opacity: to ? [0, 1] : [1, 0] },
    duration,
    easing: to ? motion.open : motion.close,
  };
}

/**
 * A motion a view takes only while it plays. At rest the view has no opacity or transform of its
 * own: a bound one, even at rest, makes a browser draw the view's text in a layer of its own
 * (greyscale, not subpixel), so the screen would not be as it was without motion. `style()` is
 * what to spread into the view's style; `play` runs a motion (a new one interrupts the last) and
 * resolves once it ends.
 */
export function passing() {
  const moving = createMotion();
  const playing = signal(false);
  let runs = 0;
  return {
    style: (): ViewStyle => (playing() ? moving.style : {}),
    async play(spec: MotionSpec) {
      const run = ++runs;
      playing.set(true);
      const result = await moving.play(spec);
      if (run === runs) playing.set(false);
      return result;
    },
  };
}
