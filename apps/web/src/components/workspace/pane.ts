import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A pane you can drag to size, and the line you drag.
 *
 * BR1's rules for the line live in `styles.css` (`.pane-divider`): 1px at rest, 2px of
 * foreground under the pointer, a 6px hit target, `col-resize` — or `row-resize` for a line across
 * a column — and, for the columns, the window's header band painted through the gutter.
 *
 * What lives here is the state: the size, the drag, and remembering it. Where it is remembered is
 * the caller's: a column's width in its own `localStorage` key (`usePaneWidth`), the sidebar's
 * agent shelf in the workspace state (`usePaneSize` with `saved`/`save`).
 */
export interface PaneSize {
  /** The size in pixels, inside the bounds: a saved size is pulled in when the bounds shrink. */
  size: number;
  /**
   * Whether a size has been chosen here, by a drag now or a saved one. Until then `size` is the
   * caller's `fallback`, and a caller whose default is the stylesheet's has nothing to write.
   */
  sized: boolean;
  dragging: boolean;
  /** Spread on the divider: pointer capture, moves, release, arrow keys, and double-click. */
  dividerProps: React.HTMLAttributes<HTMLDivElement> & {
    role: "separator";
    tabIndex: 0;
    "aria-orientation": "vertical" | "horizontal";
    "aria-valuenow": number;
    "aria-valuemin": number;
    "aria-valuemax": number;
    "data-dragging": boolean;
  };
}

/** Which edge of the pane the divider is on. Dragging the edge away from the pane grows it. */
export type PaneEdge = "left" | "right" | "top" | "bottom";

export function usePaneSize(options: {
  /** The remembered size; undefined until one has been chosen. */
  saved: number | undefined;
  /** Called once a size has landed (a drag ends, a key is pressed), or with undefined to forget it. */
  save: (size: number | undefined) => void;
  min: number;
  max: number;
  /** The size to show, and to start a drag from, while nothing is saved. */
  fallback: number;
  edge: PaneEdge;
  /** Whether a double-click forgets the size and gives the pane back its default. */
  resettable?: boolean;
}): PaneSize {
  const { saved, save, fallback, edge } = options;
  // A column narrower than its floor still has the floor; the ceiling never goes under it.
  const min = Math.round(options.min);
  const max = Math.max(min, Math.round(options.max));
  const vertical = edge === "top" || edge === "bottom";
  // Moving the pointer right (or down) grows a pane whose divider is on its right (or bottom).
  const grow = edge === "left" || edge === "top" ? -1 : 1;
  const clamp = useCallback(
    (value: number) => Math.min(max, Math.max(min, Math.round(value))),
    [min, max],
  );

  // The drag's own copy, so the pane follows every pixel and only where it lands is saved.
  const [draft, setDraft] = useState<number | undefined>(undefined);
  const chosen = draft ?? saved;
  // Read through on every render, not copied in once: `fallback` and the bounds move with the
  // window.
  const size = clamp(chosen ?? fallback);
  const dragRef = useRef<
    { start: number; startSize: number; landed: number | undefined } | undefined
  >(undefined);
  const saveRef = useRef(save);
  saveRef.current = save;

  // Saved when the drag ends, not on every pixel: the value that matters is where it landed.
  // A press that never moved chose nothing, so it does not pin the default.
  const land = useCallback(() => {
    const current = dragRef.current;
    if (current === undefined) return false;
    dragRef.current = undefined;
    if (current.landed !== undefined) saveRef.current(current.landed);
    setDraft(undefined);
    return true;
  }, []);

  useEffect(() => {
    const stop = () => {
      land();
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [land]);

  const back = vertical ? "ArrowUp" : "ArrowLeft";
  const forward = vertical ? "ArrowDown" : "ArrowRight";
  const at = (event: React.PointerEvent) =>
    vertical ? event.clientY : event.clientX;

  return {
    size,
    sized: chosen !== undefined,
    dragging: draft !== undefined,
    dividerProps: {
      role: "separator",
      // A separator's orientation is the line's: a line between two columns stands up.
      "aria-orientation": vertical ? "horizontal" : "vertical",
      "aria-valuenow": size,
      "aria-valuemin": min,
      "aria-valuemax": max,
      "data-dragging": draft !== undefined,
      tabIndex: 0,
      // The keyboard's way to drag: arrows step 16px the way the pointer would move, Home and
      // End go to the ends. Each press lands, so each press is remembered.
      onKeyDown: (event) => {
        const step = 16;
        const next =
          event.key === back
            ? clamp(size - grow * step)
            : event.key === forward
              ? clamp(size + grow * step)
              : event.key === "Home"
                ? min
                : event.key === "End"
                  ? max
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        save(next);
      },
      onPointerDown: (event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          start: at(event),
          startSize: size,
          landed: undefined,
        };
      },
      onPointerMove: (event) => {
        const current = dragRef.current;
        if (current === undefined) return;
        const next = clamp(
          current.startSize + grow * (at(event) - current.start),
        );
        current.landed = next;
        setDraft(next);
      },
      onPointerUp: (event) => {
        if (dragRef.current === undefined) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        land();
      },
      ...(options.resettable === true
        ? { onDoubleClick: () => save(undefined) }
        : {}),
    },
  };
}

/** A column's width, remembered under its own `localStorage` key. */
export interface PaneWidth extends PaneSize {
  width: number;
}

/**
 * The width is kept in `localStorage` rather than on the server because it is a property of this
 * screen, not of the person's work: the same conversation on a laptop and on a wide monitor should
 * not fight over one number.
 */
export function usePaneWidth(options: {
  storageKey: string;
  min: number;
  max: number;
  fallback: number;
  /** Which side of the window the pane is on. Dragging left grows a right-hand pane. */
  edge?: "left" | "right";
}): PaneWidth {
  const { storageKey } = options;
  const [saved, setSaved] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey));
      return Number.isFinite(stored) && stored > 0 ? stored : undefined;
    } catch {
      return undefined;
    }
  });
  const save = useCallback(
    (next: number | undefined) => {
      setSaved(next);
      try {
        if (next === undefined) localStorage.removeItem(storageKey);
        else localStorage.setItem(storageKey, String(next));
      } catch {
        /* private mode */
      }
    },
    [storageKey],
  );
  const pane = usePaneSize({
    saved,
    save,
    min: options.min,
    max: options.max,
    fallback: options.fallback,
    // `edge` here names the pane's side of the window; its divider is on the opposite edge.
    edge: options.edge === "right" ? "left" : "right",
  });
  return { ...pane, width: pane.size };
}
