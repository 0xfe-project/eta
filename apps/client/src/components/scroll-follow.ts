import type { ScrollRef, WheelEvent } from "nsh";
import { reduceMotion } from "nsh";
import { onWindows } from "../app/platform";

/** New messages glide, unless the user asked for less motion. */
export function animateFollow(reduceMotion: boolean) {
  return !reduceMotion;
}

/** Points in one wheel "line", as the desktop backends convert notches. */
const wheelLine = 16;
/** Chrome and Edge on Windows report one mouse notch as 100 points. */
const wheelNotch = 100;
/** A wheel keeps one glide going while events come within this many ms. */
const wheelGlide = 250;

/** How far a wheel event scrolls, in points (positive toward the end). */
export function wheelDistance(event: {
  delta: { y: number };
  deltaMode: "points" | "lines";
}) {
  return event.deltaMode === "lines"
    ? event.delta.y * wheelLine
    : event.delta.y;
}

/** Whether the event is a mouse notch, which glides. Touchpads send small,
 * continuous point deltas that already carry their own inertia, so those
 * follow the fingers directly; points count as a notch only in whole
 * multiples of what a browser reports for one. */
export function wheelIsNotch(event: {
  delta: { y: number };
  deltaMode: "points" | "lines";
}) {
  return (
    event.deltaMode === "lines" ||
    (event.delta.y !== 0 && event.delta.y % wheelNotch === 0)
  );
}

/** Where a wheel event aims: from where an earlier one in the same glide
 * aims, else from the offset on screen, kept within the content. */
export function wheelTarget(state: {
  offset: number;
  max: number;
  aim?: number;
  last: number;
  now: number;
  distance: number;
}) {
  const from =
    state.aim !== undefined && state.now - state.last < wheelGlide
      ? state.aim
      : state.offset;
  return Math.min(Math.max(from + state.distance, 0), Math.max(state.max, 0));
}

interface ScrollEvent {
  offset: { y: number };
  contentSize: { height: number };
  size: { height: number };
}

/** The wheel handling of one scroll area on Windows, where the wheel scrolls
 * the area itself: mouse notches glide to where `scrollTo` is told, and
 * touchpad deltas follow the fingers. `onScroll` keeps the area's end in
 * view and needs a scroll event throttle. */
export function wheelScroll(
  scrollTo: (offset: number, animated: boolean) => void,
) {
  // No scroll event yet: the end is not known, and the area clamps to it.
  let scrolled = { offset: 0, max: Number.POSITIVE_INFINITY };
  let wheel: { aim?: number; last: number } = { last: 0 };
  return {
    onScroll(event: ScrollEvent) {
      scrolled = {
        offset: event.offset.y,
        max: event.contentSize.height - event.size.height,
      };
    },
    onWheel(event: WheelEvent) {
      // The area scrolls along its own axis only.
      if (Math.abs(event.delta.x) > Math.abs(event.delta.y)) return;
      const now = Date.now();
      const target = wheelTarget({
        ...scrolled,
        aim: wheel.aim,
        last: wheel.last,
        now,
        distance: wheelDistance(event),
      });
      const glide = wheelIsNotch(event) && animateFollow(reduceMotion());
      wheel = { aim: glide ? target : undefined, last: now };
      scrollTo(target, glide);
    },
  };
}

/** Props that make a `Scroll` glide on the wheel; none off Windows, where the
 * system already scrolls smoothly. `SmoothScroll` is their one user: the
 * wheel handler must sit on a view inside the `Scroll`, not on it. */
export function glideScroll() {
  if (!onWindows) return {};
  let scroll: ScrollRef | undefined;
  const glide = wheelScroll((offset, animated) =>
    scroll?.scrollTo({ y: offset, animated }),
  );
  return {
    ref: (node: ScrollRef) => {
      scroll = node;
    },
    onWheel: glide.onWheel,
    onScroll: glide.onScroll,
    scrollEventThrottle: 16,
  };
}
