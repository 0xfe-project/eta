/** How close to the end of the transcript still counts as "at the bottom". */
export const bottomThreshold = 40;

/** Points left to scroll below the viewport, from a scroll event. */
export function distanceFromEnd(event: {
  offset: { y: number };
  contentSize: { height: number };
  size: { height: number };
}) {
  return event.contentSize.height - event.offset.y - event.size.height;
}

export function atBottom(distance: number) {
  return distance <= bottomThreshold;
}

/** Whether `next` is `previous` with rows added after its last one. A first
 * load, a switch to another conversation and older rows paged in above are
 * not: those jump or keep their place. */
export function rowsAppended(previous: string[], next: string[]) {
  const last = previous.at(-1);
  return (
    last !== undefined &&
    next.length > previous.length &&
    next.at(-1) !== last &&
    next.includes(last)
  );
}

/** Whether to scroll to the end for new rows: only a reader already at the
 * bottom follows, and one who scrolled up is never pulled back. */
export function followNewRows(
  previous: string[],
  next: string[],
  pinned: boolean,
) {
  return pinned && rowsAppended(previous, next);
}

/** New messages glide, unless the user asked for less motion. */
export function animateFollow(reduceMotion: boolean) {
  return !reduceMotion;
}
