/** Puts the terminal's own cursor on a cell of a box, so an input method's window opens there. */
import type { DOMElement } from "ink";
import type { RefObject } from "react";
import { useBoxMetrics, useCursor } from "ink";

/** Where a node sits in Ink's output, from the last layout. */
function originOf(
  node: DOMElement | null,
): { x: number; y: number } | undefined {
  let x = 0;
  let y = 0;
  for (let current = node ?? undefined; current; current = current.parentNode) {
    const layout = current.yogaNode?.getComputedLayout();
    if (layout === undefined) return undefined;
    x += layout.left;
    y += layout.top;
  }
  return { x, y };
}

/**
 * Shows the terminal cursor at `cell`, counted from the top left of the box `boxRef` points to;
 * hides it when `cell` is undefined. The box's place comes from the last layout, and the box
 * re-renders when that place changes within its parent.
 */
export function useTerminalCursor(
  boxRef: RefObject<DOMElement | null>,
  cell: { x: number; y: number } | undefined,
): void {
  const { hasMeasured } = useBoxMetrics(boxRef);
  const { setCursorPosition } = useCursor();
  const origin = hasMeasured && cell ? originOf(boxRef.current) : undefined;
  setCursorPosition(
    origin && cell && { x: origin.x + cell.x, y: origin.y + cell.y },
  );
}
