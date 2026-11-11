import { ArrowUpIcon } from "@phosphor-icons/react/ArrowUp";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The nearest ancestor that scrolls vertically, which can change with the breakpoint. */
function scroller(el: HTMLElement | null) {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/**
 * Back to top, once what scrolls around it has left the top. Put it after the
 * content, in the same box: it floats at the bottom right of what scrolls and,
 * scrolled to the end, takes its own row below the content instead of covering it.
 */
export function BackToTop({ className }: { className?: string }) {
  const { t: translateText } = useTranslation("common");
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const update = () => setShown((scroller(ref.current)?.scrollTop ?? 0) > 48);
    // Scroll events do not bubble; capturing them catches whichever ancestor scrolls.
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && e.target.contains(ref.current)) update();
    };
    document.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    // Also measures once on mount; a resize can clamp or move the scroll.
    const resize = new ResizeObserver(update);
    if (ref.current) resize.observe(ref.current);
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      resize.disconnect();
    };
  }, []);
  return (
    <div
      ref={ref}
      className={cn(
        "pointer-events-none sticky bottom-[env(safe-area-inset-bottom)] z-10 flex justify-end",
        className,
      )}
    >
      {shown ? (
        <Button
          variant="outline"
          size="icon"
          aria-label={translateText("actions.backToTop")}
          title={translateText("actions.backToTop")}
          className="pointer-events-auto my-3 shadow-sm dark:bg-background"
          onClick={() => {
            const area = scroller(ref.current);
            if (!area) return;
            area.scrollTo({ top: 0 });
            // The button goes away at the top; keep the keyboard in the content.
            // Visible ones only, skipping the side panel's other tabs.
            [
              ...area.querySelectorAll<HTMLElement>(
                "button, a[href], [tabindex]",
              ),
            ]
              .find((el) => el.checkVisibility())
              ?.focus({ preventScroll: true });
          }}
        >
          <ArrowUpIcon aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
