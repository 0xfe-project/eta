import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Long text folds to a few lines with a button to unfold it, so a long
 * description or report does not push everything else off a phone's screen.
 * `actions` sit beside that button.
 */
export function Folded({
  children,
  className,
  max = "max-h-48",
  enabled = true,
  actions,
}: {
  children: React.ReactNode;
  className?: string;
  /** The folded height, a max-h-* class. */
  max?: string;
  enabled?: boolean;
  actions?: React.ReactNode;
}) {
  const { t: translateText } = useTranslation(["common"] as const);
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || open) return;
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [enabled, open, children]);
  const isFolded = enabled && !open;
  return (
    <div className="min-w-0">
      <div
        ref={ref}
        className={cn(
          className,
          isFolded && [max, "overflow-hidden"],
          isFolded &&
            long &&
            "[mask-image:linear-gradient(to_bottom,black_70%,transparent)]",
        )}
      >
        {children}
      </div>
      {(enabled && long) || actions ? (
        <div className="-ml-2 flex flex-wrap items-center">
          {enabled && long ? (
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {open
                ? translateText("actions.collapse")
                : translateText("actions.expandFullText")}
            </Button>
          ) : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
}
