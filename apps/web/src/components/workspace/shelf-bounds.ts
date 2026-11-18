import { useCallback, useLayoutEffect, useState } from "react";

/** What the shelf can be sized to: room for its head and one card, and the list's head and two. */
export interface ShelfBounds {
  min: number;
  max: number;
  /** The shelf's height as its content lays it out, where a drag starts from until one lands. */
  natural: number;
  measured: boolean;
}

const CARD_FALLBACK = 48;

/**
 * Measures the two halves of the column: the shelf's floor is its head and one card; its ceiling
 * is what the groups and the shelf share, less the list's head and two and a half rows, so the
 * list always shows there is more of it — or the whole shelf, when that is shorter. Re-measured as
 * the column resizes and as the agents come and go, so a shorter window pulls a saved height back
 * in, and when a height is saved or forgotten, which changes the height the shelf has on its own.
 *
 * Measured before paint, and `measured` stays false until then: a saved height is not applied
 * against bounds of zero. Before paint is the layout effect's doing, and the guard does not replace
 * it: measured in a passive effect, the first paint would be the shelf at its content's height
 * whenever nothing else forced a render first. In its own module so a test can hold the hook
 * alone to that.
 */
export function useShelfBounds(
  groups: React.RefObject<HTMLElement | null>,
  shelf: React.RefObject<HTMLElement | null>,
  active: boolean,
  /** Whether a height is saved: the shelf's own height, `natural`, is another one either way. */
  sized: boolean,
): ShelfBounds {
  const [bounds, setBounds] = useState<ShelfBounds>({
    min: 0,
    max: 0,
    natural: 0,
    measured: false,
  });
  const measure = useCallback(() => {
    const list = groups.current;
    const section = shelf.current;
    if (list === null || section === null) return;
    const top = (element: HTMLElement, inside: HTMLElement) =>
      element.getBoundingClientRect().top - inside.getBoundingClientRect().top;
    const card = (inside: HTMLElement) =>
      inside.querySelector<HTMLElement>("[data-sidebar=menu-item]")
        ?.offsetHeight || CARD_FALLBACK;
    const listBody = list.querySelector<HTMLElement>("[data-sidebar=menu]");
    const shelfBody = section.querySelector<HTMLElement>("[data-shelf-body]");
    const listHead = listBody === null ? 0 : top(listBody, list);
    const shelfHead = shelfBody === null ? 0 : top(shelfBody, section);
    const min = shelfHead + card(section);
    // What the two share runs from the list's top to the bottom of the column, read off the
    // column and not as the sum of the two: when the window has just got shorter the shelf still
    // has its old height, the list is squeezed past its share, and the sum is more room than there
    // is. Read this way it does not depend on the shelf's height, so the shelf is not watched.
    const column = section.parentElement;
    const room =
      column === null
        ? list.offsetHeight + section.offsetHeight
        : column.getBoundingClientRect().top +
          column.clientTop +
          column.clientHeight -
          (Number.parseFloat(getComputedStyle(column).paddingBottom) || 0) -
          list.getBoundingClientRect().top;
    // No taller than everything in it either: past that the line would stop following the
    // pointer, and the way back down would start with a stretch that moves nothing.
    const max = Math.min(
      room - (listHead + 2.5 * card(list)),
      shelfHead + (shelfBody?.scrollHeight ?? 0),
    );
    const next = { min, max, natural: section.offsetHeight, measured: true };
    setBounds((current) =>
      current.min === next.min &&
      current.max === next.max &&
      current.natural === next.natural
        ? current
        : next,
    );
  }, [groups, shelf]);

  useLayoutEffect(() => {
    if (!active) return;
    measure();
    window.addEventListener("resize", measure);
    const column = shelf.current?.parentElement;
    const observer =
      typeof ResizeObserver === "undefined" || column == null
        ? undefined
        : new ResizeObserver(measure);
    // The column, for a narrower sidebar or a shorter window. Not the shelf itself: its height is
    // the one being dragged, so every pointer move would measure again, and nothing measured here
    // follows it (the room is read off the column; `natural` changes with `sized`, below).
    if (column != null) observer?.observe(column);
    // The cards themselves: past the cap the shelf's box stays put while its content grows.
    const cards = shelf.current?.querySelector("[data-shelf-body] > *");
    if (cards != null) observer?.observe(cards);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
    // `sized` is only here to measure again when it changes: saved, the shelf is as tall as the
    // height; forgotten, it is as tall as its content, and that is the `natural` a drag starts from.
  }, [active, measure, shelf, sized]);

  return bounds;
}
