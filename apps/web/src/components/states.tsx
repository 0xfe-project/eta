import type { ReactNode } from "react";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// What a place shows before and instead of its content, the same everywhere:
// - Loading: grey bars in the shape of what is coming, a light sweeping
//   across them, held back 180ms so a fast load never flashes them, and then
//   there all at once.
// - Empty: what goes here and how to start, centred in the space.
// - LoadError: laid out the same, saying what failed, with a retry.

/** One grey bar. Every skeleton in the app is built from these. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative h-3 overflow-hidden bg-muted after:absolute after:inset-0 after:-translate-x-full after:bg-linear-to-r after:from-transparent after:via-foreground/[0.06] after:to-transparent motion-safe:after:animate-skeleton-sweep",
        className,
      )}
    />
  );
}

const widths = ["w-3/5", "w-2/5", "w-1/2", "w-2/3", "w-1/3"];

/**
 * A transcript's turns, in the measures the real ones use: an agent's name
 * over its text, and what you said as a block on the right (`.message` in
 * styles.css). No role and no name of its own, so it can sit inside a status
 * that already has one.
 */
export function MessageSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="space-y-3 pt-1">
      {Array.from({ length: rows }, (_, i) =>
        i % 2 ? (
          <div key={i} data-turn="user" className="mb-[28px] flex justify-end">
            <Skeleton className="h-9 w-2/5 max-w-[72%]" />
          </div>
        ) : (
          <div key={i} data-turn="agent" className="mb-[28px]">
            <div className="mb-[10px] flex items-center gap-2">
              <Skeleton className="size-[18px] shrink-0" />
              <Skeleton className="w-24" />
            </div>
            <div className="space-y-2 px-[2px]">
              <Skeleton className="w-full" />
              <Skeleton className={widths[(i / 2) % 5]} />
            </div>
          </div>
        ),
      )}
    </div>
  );
}

/**
 * The phone's conversation rows (GroupList): an avatar, a name, a line under
 * it, each row as tall as a real one. Role-less, like MessageSkeleton.
 */
export function CardSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="space-y-px">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex min-h-18 items-center gap-2 px-2 py-3">
          <Skeleton className="size-6 shrink-0" />
          <div className="min-w-0 flex-1">
            <Skeleton className="w-1/2" />
            <Skeleton className="mt-1 h-2.5 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Something is loading. `list` is rows of items, `detail` a page with a
 * title and text, `lines` a few lines of text for small places, `messages` a
 * conversation's turns, `cards` the phone's conversation rows, `glyphs` a
 * folded sidebar's column of icons.
 * `immediate` drops the 180ms hold, for a place that only shows up once
 * something is already known to be slow.
 */
export function Loading({
  layout = "list",
  rows = 3,
  label,
  immediate = false,
  className,
}: {
  layout?: "list" | "detail" | "lines" | "messages" | "cards" | "glyphs";
  rows?: number;
  label?: string;
  immediate?: boolean;
  className?: string;
}) {
  const { t: translateText } = useTranslation("common");
  const lines = Array.from({ length: rows }, (_, i) => widths[i % 5]);
  return (
    <div
      role="status"
      className={cn(
        // No fade-in: the bars either are there or they are not. A skeleton that arrives gently is
        // a skeleton that made you wait for the animation on top of the load.
        !immediate && "animate-skeleton-hold",
        className,
      )}
    >
      <span className="sr-only">
        {label ?? translateText("states.loading")}
      </span>
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
      ) : layout === "glyphs" ? (
        <div className="grid">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="flex h-9 items-center justify-center">
              <Skeleton className="size-3.5" />
            </div>
          ))}
        </div>
      ) : layout === "messages" ? (
        <MessageSkeleton rows={rows} />
      ) : layout === "cards" ? (
        <CardSkeleton rows={rows} />
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
  const { t: translateText } = useTranslation("common");
  return (
    <div role="alert" className={cn(box, className)}>
      <WarningIcon aria-hidden="true" className="size-8 text-destructive" />
      <p className="text-sm font-medium">
        {translateText("errors.loadFailed", { target: what })}
      </p>
      <p className="max-w-xs text-xs break-words text-muted-foreground">
        {error.message}
      </p>
      {onRetry ? (
        <Button size="sm" variant="outline" className="mt-1" onClick={onRetry}>
          {translateText("actions.retry")}
        </Button>
      ) : null}
    </div>
  );
}
