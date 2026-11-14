import type { ReactNode } from "react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * One tool call, folded.
 *
 * The header says what ran, one line of what it was doing, and whether it is still going; `meta`
 * adds the one number worth knowing before opening it (how many lines an edit changed, the exit
 * code of a command that failed). Opening it shows the arguments and the output — the body is
 * where the scrolling lives, so the transcript keeps its shape however much a tool printed.
 *
 * Every card starts folded, wherever it is drawn (a reply's process, a task's run log) and whatever
 * the tool (a script too: it shows once the card is opened), running or done — a card never opens
 * or closes by itself, so nothing moves under the reader as a run goes on or ends. Only the reader
 * opens one, and it stays as they left it.
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
  const [open, setOpen] = useState(false);
  return (
    <details
      className={cn("tool-card", className)}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
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
  verbatim = false,
  className,
  children,
}: {
  label: string;
  /** The label is a name (a file's path) and keeps its case. */
  verbatim?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="tool-card-block">
      <span className={cn("tool-card-block-label", verbatim && "verbatim")}>
        {label}
      </span>
      <div className={cn("tool-card-block-content", className)}>{children}</div>
    </div>
  );
}
