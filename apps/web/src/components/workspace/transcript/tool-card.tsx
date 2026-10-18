import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One tool call, folded.
 *
 * The header says three things and only three: what ran, one line of what it was doing, and
 * whether it is still going. Opening it shows the arguments and the output — the body is where the
 * scrolling lives, so the transcript keeps its shape however much a tool printed.
 */
export function ToolCard({
  tool,
  summary,
  status,
  statusLabel,
  className,
  children,
}: {
  tool: string;
  /** One line out of the arguments — the thing the call is *doing*, not the whole JSON. */
  summary?: string | undefined;
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
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="tool-card-block">
      <span className="tool-card-block-label">{label}</span>
      <div className="tool-card-block-content">{children}</div>
    </div>
  );
}
