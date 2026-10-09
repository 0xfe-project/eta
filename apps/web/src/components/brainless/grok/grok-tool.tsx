import * as React from "react";
import { ToolDisclosure } from "@/components/brainless/tool-disclosure";
import { cn } from "@/lib/utils";

/**
 * GrokTool — a Grok action line.
 *
 * Two captured forms:
 *   1. Compact: `read app/page.tsx` (dim verb, blue path)
 *   2. Card:    `┃  ◆ Run Write …  [hooks: 3]` (left gutter + diamond)
 */
const GREEN = "var(--terminal-success)"; // 38;5;10 — active Run tool cards
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
  const card = variant === "card";
  const heading = card ? (
    <span className="font-semibold" style={{ color: SILVER }}>
      {title ?? [verb, path].filter(Boolean).join(" ")}
    </span>
  ) : (
    <>
      {verb}
      {verb && path ? " " : null}
      {path ? <span style={{ color: BLUE }}>{path}</span> : null}
    </>
  );
  return (
    <ToolDisclosure
      className={cn(
        "text-[var(--terminal-muted)]",
        card && "border-l-2 border-[var(--terminal-success)] pl-3",
        className,
      )}
      heading={heading}
      leading={card ? <span style={{ color: GREEN }}>◆</span> : undefined}
      trailing={card && hooks != null ? `hooks: ${hooks}` : meta}
    >
      {children}
    </ToolDisclosure>
  );
}
