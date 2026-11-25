import type { Easing, KeyframeValue, MotionSpec, ViewStyle } from "nsh";
import { createMotion, LayoutAnimation, reduceMotion, signal } from "nsh";
import { space } from "./tokens";

// The app's motion, said once (#378, #379 and #380 share this file): every duration, curve and
// distance something moves or waits by is here, beside what it is for. Durations are
// milliseconds, distances points. When the user asks for less motion, NSH lands every motion
// where it ends at once: nothing here plays then.

export const motion = {
  /** A wait shorter than this shows nothing: a spinner or a skeleton appears only once a wait
   * has lasted this long (#380). */
  reveal: 300,
  /** A spinner or a skeleton that appeared stays at least this long, so it never flashes. */
  minShown: 500,
  /** One turn of a continuous indeterminate spinner. */
  spin: 800,
  /** Action-icon spin (SpinningIcon): accelerates over the first 18%, sustains at ~600°/s,
   * decelerates over the last 18%, minimum 640 ms for one full turn, landing on a whole turn. */
  spinAction: {
    rampMs: 120,
    rampDeg: 36,
    sustainFirstMs: 480,
    sustainNextMs: 540,
    finishLinearMs: 60,
    minTurnMs: 640,
  },
  /** A dialog, sheet or drawer coming in (`Modal`): the phone's and the larger windows'. The
   * phone's is longer, as the spec of #379 asks for sheets (350–500 ms), the others about 2/3. */
  dialogIn: { phone: 360, window: 240 },
  /** The same going out: a little quicker than it came. */
  dialogOut: { phone: 260, window: 180 },
  /** A page pushed in on the phone (a conversation over the chat list, a task, a page of More),
   * or the one under it coming back. */
  pageIn: 320,
  /** The same page going back off the one under it: a little quicker than it came. */
  pageOut: 260,
  /** A popup menu growing from its trigger, and going back into it: the spec's menus are
   * 350–500 ms on a phone, about 2/3 of that on the larger windows, the only ones with popups. */
  menuIn: 240,
  menuOut: 160,
  /** How much smaller a popup menu starts than it ends. */
  menuScale: 0.96,
  /** Rows making way as a group or a parent folds or unfolds, within the screen: the rows that
   * stay move over all of it, the rows that come fade in over its second half and the rows that
   * go fade out over its first 30%. */
  fold: 260,
  /** How far a dialog, sheet, drawer or page travels while it fades. */
  shift: space[16],
  /** In and out of a screen: `cubic-bezier(.32,.72,0,1)`, the spec's opening curve. */
  open: [0.32, 0.72, 0, 1] as Easing,
  /** Going away: eases in, so it leaves quickly once it starts. */
  close: [0.32, 0, 0.67, 0] as Easing,
  /** The avatar editor: each face passing over before one lands, the landed face settling, a
   * face taken back from the recent ones fading in. */
  avatarFlick: 60,
  avatarSettle: 160,
  avatarFade: 120,
  /** How long an agent face's idle motion takes to come in or die away, as
   * `@blobatar/react-native` ramps it. */
  faceRamp: 400,
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

/**
 * A popup menu growing out of its trigger's corner and going back into it, as a popup's
 * `popupStyle` (its transition), `popupStartingStyle` and `popupEndingStyle`: `align` is the
 * trigger's edge the menu lines up with. With less motion asked for it has none of them: it comes
 * and goes at once, as before.
 */
export function menuMotion(align: "start" | "end", reduced: boolean) {
  if (reduced) return { style: {}, starting: undefined, ending: undefined };
  const away: ViewStyle = {
    opacity: 0,
    transform: [{ translateY: -space[4] }, { scale: motion.menuScale }],
  };
  return {
    style: {
      transformOrigin: align === "end" ? "top right" : "top left",
      transitionProperty: "opacity, transform",
      transitionDuration: motion.menuIn,
      transitionTimingFunction: curve(motion.open),
    } satisfies ViewStyle,
    starting: away,
    ending: {
      ...away,
      transitionDuration: motion.menuOut,
      transitionTimingFunction: curve(motion.close),
    } satisfies ViewStyle,
  };
}

/** A curve as a style's `cubic-bezier()`. */
function curve(points: Easing) {
  return `cubic-bezier(${(points as number[]).join(", ")})` as const;
}

/**
 * Call just before folding or unfolding a group or a parent: in the change that follows, the
 * rows that stay move to their new places (ease in and out, as moves within a screen do), the
 * rows that come fade in once the others have mostly moved and the rows that go fade out first.
 * With less motion asked for, the change happens at once, as before.
 */
export function foldNext() {
  if (reduceMotion()) return;
  LayoutAnimation.configureNext({
    duration: motion.fold,
    update: { type: "easeInEaseOut" },
    create: {
      type: "easeInEaseOut",
      property: "opacity",
      duration: motion.fold / 2,
      delay: motion.fold / 2,
    },
    delete: {
      type: "easeInEaseOut",
      property: "opacity",
      duration: motion.fold * 0.3,
    },
  });
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
    async play(spec: MotionSpec, afterMount = false) {
      const run = ++runs;
      if (afterMount && !reduceMotion()) {
        // What comes in with a page that mounts (a conversation, a task) waits at its first
        // frame until the mount is done: a heavy mount would otherwise take the first part of
        // the motion before a frame of it is drawn.
        for (const [channel, frames] of Object.entries(spec.keyframes)) {
          const first = (frames as KeyframeValue[])[0];
          if (typeof first === "number")
            moving[channel as "opacity"].set(first);
        }
        playing.set(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (run !== runs) return { finished: false };
      }
      playing.set(true);
      const result = await moving.play(spec);
      if (run === runs) playing.set(false);
      return result;
    },
    /** How far in it is (its opacity): 1 at rest. */
    async shown() {
      return playing() ? moving.opacity.getValue() : 1;
    },
  };
}

/**
 * A page pushed over another on a phone (a conversation over the chat list, a task over the page
 * it opened from, Settings): it comes in over the page under it and goes back off it, so the
 * page under is drawn through the move instead of a blank frame. Its owner draws the page under
 * while `under()` (as it comes in) and itself while `leaving()` (as it goes, taking no presses
 * then), and spreads `style()` into the pushed page's layer, which is opaque.
 *
 * Going back mid-way starts from where it got to; `settle()` drops what is moving (a tab change
 * changes at once). With less motion asked for NSH lands each move at once, so the page under is
 * there for no frame longer.
 */
export function pushed() {
  const moving = passing();
  const under = signal(false);
  const leaving = signal(false);
  let runs = 0;
  return {
    style: moving.style,
    under: () => under(),
    leaving: () => leaving(),
    /** It came in over the page under it. */
    async enter() {
      const run = ++runs;
      leaving.set(false);
      under.set(true);
      await moving.play(fadeIn("end", motion.pageIn), true);
      if (run === runs) under.set(false);
    },
    /** It goes back off the page under it. */
    async leave() {
      const run = ++runs;
      under.set(false);
      leaving.set(true);
      const from = await moving.shown();
      if (run !== runs) return;
      await moving.play({
        keyframes: {
          opacity: [from, 0],
          translateX: [motion.shift * (1 - from), motion.shift],
        },
        duration: motion.pageOut * from,
        easing: motion.close,
      });
      if (run === runs) leaving.set(false);
    },
    /** Another page took its place within it: that one comes in from `from`. */
    swap(from: MotionFrom) {
      ++runs;
      under.set(false);
      leaving.set(false);
      void moving.play(fadeIn(from, motion.pageIn), true);
    },
    settle() {
      ++runs;
      under.set(false);
      leaving.set(false);
    },
  };
}
