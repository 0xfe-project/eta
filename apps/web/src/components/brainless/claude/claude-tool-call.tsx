import * as React from "react";
import { toolHeadingClass } from "@/components/brainless/tool-call-styles";
import { cn } from "@/lib/utils";

/**
 * ClaudeToolCall — Claude Code's collapsed tool/result line.
 *
 * In the terminal this is faked with box-drawing glyphs and a "ctrl+o to
 * expand" hint. Here it's a real <details> disclosure: keyboard-operable,
 * announced to screen readers, and it keeps the exact ⏺ / ⎿ visual grammar.
 */
type Status = "success" | "error" | "pending";

const STATUS_COLOR: Record<Status, string> = {
  success: "var(--terminal-success)",
  error: "var(--terminal-error)",
  pending: "var(--terminal-warning)",
};

export function ClaudeToolCall({
  tool,
  arg,
  result,
  status = "success",
  defaultOpen = false,
  className,
  children,
}: {
  tool: string;
  arg?: string;
  result: string;
  status?: Status;
  defaultOpen?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  const expandable = Boolean(children);

  return (
    <details
      open={defaultOpen}
      className={cn(
        "group min-w-0 max-w-full font-mono text-[13px] leading-[1.55] [&_summary::-webkit-details-marker]:hidden",
        className,
      )}
    >
      <summary
        className={cn(
          "list-none",
          "cursor-pointer",
          "rounded-none outline-none focus-visible:ring-1 focus-visible:ring-[var(--terminal-link)]/60",
        )}
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            aria-hidden
            className="shrink-0"
            style={{ color: STATUS_COLOR[status] }}
          >
            ⏺
          </span>
          <span className={toolHeadingClass}>
            <span className="text-[var(--terminal-claude-foreground)]">
              {tool}
            </span>
            {arg !== undefined ? (
              <>
                <span className="text-[var(--terminal-muted)]">(</span>
                <span className="text-[var(--terminal-link)]">{arg}</span>
                <span className="text-[var(--terminal-muted)]">)</span>
              </>
            ) : null}
          </span>
        </span>
        <span className="flex min-w-0 items-baseline gap-2 text-[var(--terminal-muted)]">
          {/* invisible status glyph spacer: aligns ⎿ under the tool name */}
          <span aria-hidden className="invisible shrink-0">
            ⏺
          </span>
          <span className="flex min-w-0 items-baseline gap-2">
            <span aria-hidden className="shrink-0 text-[var(--terminal-muted)]">
              ⎿
            </span>
            <span className="min-w-0 break-words">
              {result}
              {expandable ? (
                <span className="ml-2 text-[var(--terminal-muted)] group-open:hidden">
                  （点击展开）
                </span>
              ) : null}
            </span>
          </span>
        </span>
      </summary>

      {expandable ? (
        <div className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] pl-[32px] text-[var(--terminal-muted)]">
          {children}
        </div>
      ) : null}
    </details>
  );
}
