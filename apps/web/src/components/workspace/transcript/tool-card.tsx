import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One tool call, folded.
 *
 * The header says what ran, one line of what it was doing, and whether it is still going; `meta`
 * adds the one number worth knowing before opening it (how many lines an edit changed, the exit
 * code of a command that failed). Opening it shows the arguments and the output — the body is
 * where the scrolling lives, so the transcript keeps its shape however much a tool printed.
 */
export function ToolCard({
  tool,
  summary,
  meta,
  status,
  statusLabel,
  className,
  children,
}: {
  tool: string;
  /** One line out of the arguments — the thing the call is *doing*, not the whole JSON. */
  summary?: string | undefined;
  /** A short fact about the outcome, beside the status. */
  meta?: ReactNode;
  status: "running" | "completed" | "failed";
  statusLabel: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <details className={cn("tool-card", className)}>
      <summary className="tool-card-head">
        <span className="tool-card-label">
          {tool}
          {summary === undefined || summary.length === 0 ? "" : ` · ${summary}`}
        </span>
        {meta === undefined || meta === null ? null : (
          <span className="tool-card-meta">{meta}</span>
        )}
        <span
          className={cn(
            "tool-card-status",
            status === "running" && "running",
            status === "failed" && "failed",
          )}
        >
          {statusLabel}
        </span>
      </summary>
      {children}
    </details>
  );
}

/** One labelled block inside a tool card: the arguments, or the output. */
export function ToolCardBlock({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="tool-card-block">
      <span className="tool-card-block-label">{label}</span>
      <div className={cn("tool-card-block-content", className)}>{children}</div>
    </div>
  );
}
