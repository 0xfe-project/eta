import * as React from "react";
import { toolHeadingClass } from "@/components/brainless/tool-call-styles";
import { cn } from "@/lib/utils";

/**
 * CodexExec — a Codex action/exec line: a command or edit with an optional
 * result count, and expandable output as a real <details> disclosure.
 */
type Status = "ok" | "error" | "run";

const DOT: Record<Status, string> = {
  ok: "var(--terminal-success)",
  error: "var(--terminal-error)",
  run: "var(--terminal-warning)",
};

export function CodexExec({
  command,
  result,
  status = "ok",
  defaultOpen = false,
  className,
  children,
}: {
  command: string;
  result?: string;
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
          "flex min-w-0 list-none items-baseline gap-2 outline-none",
          "cursor-pointer",
          "focus-visible:ring-1 focus-visible:ring-[var(--terminal-link)]/60",
        )}
      >
        <span aria-hidden className="shrink-0" style={{ color: DOT[status] }}>
          •
        </span>
        <span className={cn(toolHeadingClass, "text-[var(--terminal-link)]")}>
          {command}
        </span>
        {result ? (
          <span className="shrink-0 text-[var(--terminal-muted)]">
            {result}
          </span>
        ) : null}
        {expandable ? (
          <span className="shrink-0 text-[var(--terminal-muted)] group-open:hidden">
            ▸
          </span>
        ) : null}
      </summary>
      {expandable ? (
        <pre className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] pl-4 text-[var(--terminal-muted)]">
          {children}
        </pre>
      ) : null}
    </details>
  );
}
