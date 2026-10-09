import * as React from "react";
import { toolHeadingClass } from "@/components/brainless/tool-call-styles";
import { cn } from "@/lib/utils";

/**
 * GrokTool — a Grok action line.
 *
 * Two captured forms:
 *   1. Compact: `read app/page.tsx` (dim verb, blue path)
 *   2. Card:    `┃  ◆ Run Write …  [hooks: 3]` (left gutter + diamond)
 */
const GREEN = "var(--terminal-success)"; // 38;5;10 — active Run tool cards
const MUTED = "var(--terminal-muted)";
const DIM = "var(--terminal-muted)";
const BLUE = "var(--terminal-link)";
const SILVER = "var(--terminal-secondary)";

export function GrokTool({
  verb,
  path,
  meta,
  variant = "line",
  title,
  hooks,
  className,
  children,
}: {
  verb?: string;
  path?: string;
  meta?: string;
  variant?: "line" | "card";
  /** Card title, e.g. "Run Write permission probe output file". */
  title?: string;
  hooks?: number;
  className?: string;
  children?: React.ReactNode;
}) {
  if (variant === "card") {
    const heading = title ?? [verb, path].filter(Boolean).join(" ");
    return (
      <details
        className={cn(
          "group min-w-0 max-w-full [&_summary::-webkit-details-marker]:hidden border-l-2 pl-3 font-mono text-[13px] leading-[1.55]",
          className,
        )}
        style={{ borderColor: GREEN }}
      >
        <summary className="flex min-w-0 list-none cursor-pointer items-baseline gap-x-2 outline-none focus-visible:ring-1 focus-visible:ring-[var(--terminal-link)]/60">
          <span aria-hidden className="shrink-0" style={{ color: GREEN }}>
            ◆
          </span>
          <span
            className={cn(toolHeadingClass, "font-semibold")}
            style={{ color: SILVER }}
          >
            {heading}
          </span>
          {hooks != null ? (
            <span className="shrink-0" style={{ color: DIM }}>
              [hooks: <span style={{ color: GREEN }}>{hooks}</span>]
            </span>
          ) : null}
        </summary>
        {children ? (
          <div
            className="mt-1 min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]"
            style={{ color: MUTED }}
          >
            {children}
          </div>
        ) : null}
      </details>
    );
  }

  return (
    <details
      className={cn(
        "group min-w-0 max-w-full font-mono text-[13px] leading-[1.6] text-[var(--terminal-muted)] [&_summary::-webkit-details-marker]:hidden",
        className,
      )}
    >
      <summary className="flex min-w-0 list-none cursor-pointer items-baseline gap-2 outline-none focus-visible:ring-1 focus-visible:ring-[var(--terminal-link)]/60">
        <span className={toolHeadingClass}>
          {verb}
          {verb && path ? " " : null}
          {path ? <span style={{ color: BLUE }}>{path}</span> : null}
        </span>
        {meta ? (
          <span className="shrink-0 text-[var(--terminal-muted)]">{meta}</span>
        ) : null}
      </summary>
      {children ? (
        <div
          className="mt-1 min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]"
          style={{ color: MUTED }}
        >
          {children}
        </div>
      ) : null}
    </details>
  );
}
