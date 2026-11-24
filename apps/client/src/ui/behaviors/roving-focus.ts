import type { KeyEvent, ViewRef } from "nsh";
import { signal } from "nsh";

type Orientation = "horizontal" | "vertical";

interface RovingFocusOptions<T extends string = string> {
  orientation?: Orientation;
  loop?: boolean;
  /** Controlled active/focused item id; falls back to internal state when omitted. */
  activeId?: () => T | undefined;
  items: () => readonly { id: T; disabled?: boolean }[];
  onFocusChange?: (id: T) => void;
}

/**
 * Roving-tabindex keyboard navigation for lists, tablists, segmented controls, and menus.
 * Keeps one Tab stop on the active item while Arrow / Home / End keys move focus across enabled items.
 */
export function createRovingFocus<T extends string = string>(
  options: RovingFocusOptions<T>,
) {
  const orientation = options.orientation ?? "horizontal";
  const loop = options.loop ?? true;
  const refs = new Map<T, ViewRef>();
  const internal = signal<T | undefined>(undefined);

  const enabledItems = () => options.items().filter((item) => !item.disabled);

  const activeId = (): T | undefined => {
    const controlled = options.activeId?.();
    if (controlled !== undefined) return controlled;
    const current = internal();
    const list = enabledItems();
    if (current !== undefined && list.some((item) => item.id === current))
      return current;
    return list[0]?.id;
  };

  function focusId(id: T) {
    internal.set(id);
    options.onFocusChange?.(id);
    refs.get(id)?.focus();
  }

  function move(delta: 1 | -1) {
    const list = enabledItems();
    if (list.length === 0) return undefined;
    const current = activeId();
    const index = list.findIndex((item) => item.id === current);
    const start = index === -1 ? (delta > 0 ? -1 : list.length) : index;
    const raw = start + delta;
    const nextIndex = loop
      ? (raw + list.length) % list.length
      : Math.max(0, Math.min(list.length - 1, raw));
    const target = list[nextIndex]?.id;
    if (target !== undefined) focusId(target);
    return target;
  }

  function focusEdge(edge: "first" | "last") {
    const list = enabledItems();
    const target = edge === "first" ? list[0]?.id : list.at(-1)?.id;
    if (target !== undefined) focusId(target);
    return target;
  }

  const prevKey = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
  const nextKey = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
  const prevStroke = orientation === "horizontal" ? "left" : "up";
  const nextStroke = orientation === "horizontal" ? "right" : "down";

  function onKeyDown(event: KeyEvent): boolean {
    if (event.key === nextKey) {
      move(1);
      return true;
    }
    if (event.key === prevKey) {
      move(-1);
      return true;
    }
    if (event.key === "Home") {
      focusEdge("first");
      return true;
    }
    if (event.key === "End") {
      focusEdge("last");
      return true;
    }
    return false;
  }

  return {
    activeId,
    focusId,
    move,
    focusEdge,
    onKeyDown,
    captureKeys: [prevStroke, nextStroke, "home", "end"] as readonly string[],
    register(id: T, node: ViewRef | null | undefined) {
      if (node) refs.set(id, node);
      else refs.delete(id);
    },
    isTabStop(id: T) {
      return activeId() === id;
    },
  };
}
