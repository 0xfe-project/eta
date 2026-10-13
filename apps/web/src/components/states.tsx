import type { ReactNode } from "react";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// What a place shows before and instead of its content, the same everywhere:
// - Loading: grey bars in the shape of what is coming, faded in after a beat
//   so a fast load never flashes them.
// - Empty: what goes here and how to start, centred in the space.
// - LoadError: laid out the same, saying what failed, with a retry.

function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("h-3 bg-muted motion-safe:animate-pulse", className)}
    />
  );
}

const widths = ["w-3/5", "w-2/5", "w-1/2", "w-2/3", "w-1/3"];

/**
 * Something is loading. `list` is rows of items, `detail` a page with a
 * title and text, `lines` a few lines of text for small places.
 */
export function Loading({
  layout = "list",
  rows = 3,
  label = "正在加载…",
  className,
}: {
  layout?: "list" | "detail" | "lines";
  rows?: number;
  label?: string;
  className?: string;
}) {
  const lines = Array.from({ length: rows }, (_, i) => widths[i % 5]);
  return (
    <div
      role="status"
      className={cn(
        "motion-safe:animate-in motion-safe:fill-mode-backwards motion-safe:fade-in motion-safe:delay-300",
        className,
      )}
    >
      <span className="sr-only">{label}</span>
      {layout === "list" ? (
        <div className="grid">
          {lines.map((width, i) => (
            <div key={i} className="flex h-9 items-center gap-3 px-2">
              <Skeleton className="size-3.5 shrink-0" />
              <Skeleton className={width} />
              <Skeleton className="ml-auto w-10 shrink-0" />
            </div>
          ))}
        </div>
      ) : layout === "detail" ? (
        <div className="space-y-3">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="w-1/4" />
          <div className="space-y-2 pt-3">
            {lines.map((width, i) => (
              <Skeleton key={i} className={i % 2 ? "w-full" : width} />
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {lines.map((width, i) => (
            <Skeleton key={i} className={width} />
          ))}
        </div>
      )}
    </div>
  );
}

const box = "flex flex-col items-center gap-2 px-6 py-10 text-center";

/** Nothing here yet: what goes here, and the way to start. */
export function Empty({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon?: typeof WarningIcon;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(box, className)}>
      {Icon ? (
        <Icon aria-hidden="true" className="size-8 text-muted-foreground" />
      ) : null}
      <p className="text-sm font-medium text-balance">{title}</p>
      {children ? (
        <p className="max-w-xs text-xs text-balance text-muted-foreground">
          {children}
        </p>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

/** Loading `what` failed; `onRetry` asks again. */
export function LoadError({
  what,
  error,
  onRetry,
  className,
}: {
  what: string;
  error: Error;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={cn(box, className)}>
      <WarningIcon aria-hidden="true" className="size-8 text-destructive" />
      <p className="text-sm font-medium">无法加载{what}</p>
      <p className="max-w-xs text-xs break-words text-muted-foreground">
        {error.message}
      </p>
      {onRetry ? (
        <Button size="sm" variant="outline" className="mt-1" onClick={onRetry}>
          重试
        </Button>
      ) : null}
    </div>
  );
}
