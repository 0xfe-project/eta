import { useCallback, useEffect, useRef, useState } from "react";
import { Sidebar } from "./app-shell";

/**
 * The left pane, and the line you drag to size it.
 *
 * BR1's rules for this line are in `styles.css` (`.pane-divider`): 1px at rest, 2px of foreground
 * under the pointer, a 6px hit target, `col-resize`. What lives here is the state: the width, the
 * drag, and remembering it.
 *
 * The width is kept in `localStorage` rather than on the server because it is a property of this
 * screen, not of the person's work — the same conversation on a laptop and on a wide monitor
 * should not fight over one number. The bounds are the ones the layout can actually hold: below
 * 260px a folder path and a conversation name cannot share a row; above 420px the pane starts
 * competing with the chat column, which is the thing being read.
 */

const MIN = 260;
const MAX = 420;
const DEFAULT = 288;
const STORAGE_KEY = "eta.sidebar.width";

function clamp(width: number): number {
  return Math.min(MAX, Math.max(MIN, Math.round(width)));
}

function rememberedWidth(): number {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? clamp(stored) : DEFAULT;
  } catch {
    // Storage denied: the default still works, it is just not remembered.
    return DEFAULT;
  }
}

export function SidebarPane() {
  const [width, setWidth] = useState(rememberedWidth);
  const dragRef = useRef<{ startX: number; startWidth: number } | undefined>(
    undefined,
  );
  const [dragging, setDragging] = useState(false);

  // Saved when the drag ends, not on every pixel: the value that matters is where it landed.
  const remember = useCallback((next: number) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      /* private mode */
    }
  }, []);

  useEffect(() => {
    const stop = () => {
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

  return (
    <>
      <Sidebar width={width} />
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整左栏宽度"
        aria-valuenow={width}
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        data-dragging={dragging}
        className="pane-divider hidden md:block"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { startX: event.clientX, startWidth: width };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const current = dragRef.current;
          if (current === undefined) return;
          setWidth(
            clamp(current.startWidth + (event.clientX - current.startX)),
          );
        }}
        onPointerUp={(event) => {
          if (dragRef.current === undefined) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          dragRef.current = undefined;
          setDragging(false);
          remember(width);
        }}
      />
    </>
  );
}
