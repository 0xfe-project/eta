import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Native tool disclosure, including calls that have no output yet. */
export function ToolDisclosure({
  heading,
  leading,
  trailing,
  defaultOpen = false,
  className,
  children,
}: {
  heading: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className={cn(
        "group min-w-0 max-w-full font-mono text-[13px] leading-[1.55] [&_summary::-webkit-details-marker]:hidden",
        className,
      )}
    >
      <summary className="flex min-w-0 list-none cursor-pointer items-baseline gap-2 outline-none focus-visible:ring-1 focus-visible:ring-[var(--terminal-link)]/60">
        {leading ? (
          <span aria-hidden className="shrink-0">
            {leading}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate group-open:whitespace-pre-wrap group-open:[overflow-wrap:anywhere]">
          {heading}
        </span>
        {trailing ? (
          <span className="max-w-[40%] truncate text-[var(--terminal-muted)] group-open:whitespace-pre-wrap group-open:[overflow-wrap:anywhere]">
            {trailing}
          </span>
        ) : null}
        <span aria-hidden className="shrink-0 text-[var(--terminal-muted)]">
          <span className="group-open:hidden">▸</span>
          <span className="hidden group-open:inline">▾</span>
        </span>
      </summary>
      {children ? (
        <div className="mt-1 min-w-0 whitespace-pre-wrap pl-4 text-[var(--terminal-muted)] [overflow-wrap:anywhere]">
          {children}
        </div>
      ) : null}
    </details>
  );
}
