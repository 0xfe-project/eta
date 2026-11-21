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
