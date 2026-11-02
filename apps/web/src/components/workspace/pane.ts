import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A column you can drag to size, and the line you drag.
 *
 * BR1's rules for the line live in `styles.css` (`.pane-divider`): 1px at rest, 2px of
 * foreground under the pointer, a 6px hit target, `col-resize`, and — because the window's header
 * is one band across all three columns — the gutter paints that band and the rule under it too.
 *
 * What lives here is the state: the width, the drag, and remembering it. The width is kept in
 * `localStorage` rather than on the server because it is a property of this screen, not of the
 * person's work: the same conversation on a laptop and on a wide monitor should not fight over
 * one number.
 */
export interface PaneWidth {
  width: number;
  dragging: boolean;
  /** Spread on the divider: pointer capture, moves, release, and arrow keys. */
  dividerProps: React.HTMLAttributes<HTMLDivElement> & {
    role: "separator";
    tabIndex: 0;
    "aria-orientation": "vertical";
    "aria-valuenow": number;
    "aria-valuemin": number;
    "aria-valuemax": number;
    "data-dragging": boolean;
  };
}

export function usePaneWidth(options: {
  storageKey: string;
  min: number;
  max: number;
  fallback: number;
  /** Which edge the divider is on. Dragging left grows a right-hand pane. */
  edge?: "left" | "right";
}): PaneWidth {
  const { storageKey, min, max, fallback } = options;
  const grow = options.edge === "right" ? -1 : 1;
  const clamp = useCallback(
    (value: number) => Math.min(max, Math.max(min, Math.round(value))),
    [min, max],
  );
  const read = useCallback(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey));
      return Number.isFinite(stored) && stored > 0 ? clamp(stored) : fallback;
    } catch {
      return fallback;
    }
  }, [storageKey, fallback, clamp]);

  const [width, setWidth] = useState(read);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | undefined>(
    undefined,
  );

  useEffect(() => {
    const stop = () => {
      if (dragRef.current === undefined) return;
      dragRef.current = undefined;
      setDragging(false);
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  // Saved when the drag ends, not on every pixel: the value that matters is where it landed.
  const remember = useCallback(
    (next: number) => {
      try {
        localStorage.setItem(storageKey, String(next));
      } catch {
        /* private mode */
      }
    },
    [storageKey],
  );

  return {
    width,
    dragging,
    dividerProps: {
      role: "separator",
      "aria-orientation": "vertical",
      "aria-valuenow": width,
      "aria-valuemin": min,
      "aria-valuemax": max,
      "data-dragging": dragging,
      tabIndex: 0,
      // The keyboard's way to drag: arrows step 16px the way the pointer would move, Home and
      // End go to the ends. Each press lands, so each press is remembered.
      onKeyDown: (event) => {
        const step = 16;
        const next =
          event.key === "ArrowLeft"
            ? clamp(width - grow * step)
            : event.key === "ArrowRight"
              ? clamp(width + grow * step)
              : event.key === "Home"
                ? min
                : event.key === "End"
                  ? max
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        setWidth(next);
        remember(next);
      },
      onPointerDown: (event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { startX: event.clientX, startWidth: width };
        setDragging(true);
      },
      onPointerMove: (event) => {
        const current = dragRef.current;
        if (current === undefined) return;
        setWidth(
          clamp(current.startWidth + grow * (event.clientX - current.startX)),
        );
      },
      onPointerUp: (event) => {
        if (dragRef.current === undefined) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        dragRef.current = undefined;
        setDragging(false);
        remember(width);
      },
    },
  };
}
