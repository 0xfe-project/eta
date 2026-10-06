import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * CodexHeader — Codex CLI's launch card. Monochrome and terse, matching the
 * real `>_ OpenAI Codex` box with its model / directory rows.
 */
export function CodexHeader({
  version = "v0.132.0",
  model = "gpt-5.6-sol low",
  directory = "~/dev/brainless",
  className,
}: {
  version?: string;
  model?: string;
  directory?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-[6px] border border-[var(--terminal-border)] px-3 py-3 font-mono text-[13px] leading-[1.7] text-[var(--terminal-foreground)] sm:px-4",
        className,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span aria-hidden className="shrink-0 text-[var(--terminal-muted)]">
          {">_"}
        </span>
        <span className="font-medium">OpenAI Codex</span>
        <span className="text-[var(--terminal-muted)]">({version})</span>
      </div>
      <div className="mt-2 grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-3">
        <span className="text-[var(--terminal-muted)]">模型：</span>
        <span className="min-w-0 break-words">
          {model}
          <span className="ml-3 text-[var(--terminal-link)]">/model</span>
          <span className="ml-1 text-[var(--terminal-muted)]">切换模型</span>
        </span>
        <span className="text-[var(--terminal-muted)]">目录：</span>
        <span className="truncate">{directory}</span>
      </div>
    </div>
  );
}
