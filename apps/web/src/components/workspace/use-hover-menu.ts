import type { FocusEvent, PointerEvent } from "react";
import { useEffect, useRef, useState } from "react";

// Long enough that passing over the trigger, or crossing the gap to the
// menu, does neither.
const openDelay = 100;
const closeDelay = 250;

const isMouse = (event: PointerEvent) => event.pointerType === "mouse";

/**
 * Lets a mouse open a Radix dropdown menu by hovering its trigger; touch and
 * keyboard keep Radix's own click and keys. A hovered-open menu is non-modal
 * (no scroll lock), leaves focus where it was, and closes a moment after the
 * pointer leaves both trigger and menu; clicking the trigger keeps it open.
 * Spread `root` on the menu, `trigger` on its trigger and `content` on its
 * content.
 */
export function useHoverMenu() {
  const [open, setOpen] = useState(false);
  // How the menu last opened; kept while it closes, so it doesn't remount.
  const [hovered, setHovered] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const overTriggerRef = useRef(false);
  // Closed under the pointer (say, by choosing): wait for it to leave.
  const blockedRef = useRef(false);
  const pinnedRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const later = (action: () => void, delay: number) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(action, delay);
  };
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const change = (next: boolean) => {
    clearTimeout(timerRef.current);
    if (next) setHovered(false);
    else {
      pinnedRef.current = false;
      blockedRef.current = overTriggerRef.current;
    }
    setOpen(next);
  };
  const leave = (event: PointerEvent) => {
    if (open && hovered && !pinnedRef.current && isMouse(event))
      later(() => change(false), closeDelay);
  };
  const stay = (event: PointerEvent) => {
    if (open && hovered && isMouse(event)) clearTimeout(timerRef.current);
  };

  return {
    root: { open, onOpenChange: change, modal: !hovered },
    trigger: {
      ref: triggerRef,
      onPointerEnter: (event: PointerEvent) => {
        if (!isMouse(event)) return;
        overTriggerRef.current = true;
        if (open) stay(event);
        else if (!blockedRef.current)
          later(() => {
            setHovered(true);
            setOpen(true);
          }, openDelay);
      },
      onPointerLeave: (event: PointerEvent) => {
        if (!isMouse(event)) return;
        overTriggerRef.current = false;
        blockedRef.current = false;
        if (open) leave(event);
        else clearTimeout(timerRef.current);
      },
      onPointerDown: (event: PointerEvent) => {
        // Radix would toggle it shut; the first click on a hovered-open menu
        // keeps it open instead, focused for the keys, the next one closes it.
        if (open && hovered && !pinnedRef.current && isMouse(event)) {
          event.preventDefault();
          clearTimeout(timerRef.current);
          pinnedRef.current = true;
          contentRef.current?.focus({ preventScroll: true });
        }
      },
    },
    content: {
      ref: contentRef,
      onPointerEnter: stay,
      onPointerLeave: leave,
      // A non-modal menu takes a press on its trigger for one outside it.
      onPointerDownOutside: (event: Event) => {
        if (triggerRef.current?.contains(event.target as Node))
          event.preventDefault();
      },
      onOpenAutoFocus: (event: Event) => {
        if (hovered) event.preventDefault();
      },
      onCloseAutoFocus: (event: Event) => {
        if (hovered) event.preventDefault();
      },
      // Radix focuses the content when the pointer leaves an item, even as
      // it closes: say, for the dialog the item opened, which the overlay
      // slides under the pointer. Give the focus back.
      onFocus: (event: FocusEvent) => {
        if (
          !open &&
          event.target === event.currentTarget &&
          event.relatedTarget instanceof HTMLElement
        )
          event.relatedTarget.focus();
      },
    },
  };
}
