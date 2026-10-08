import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * GrokEvent — a ◆ diamond event line from Grok's transcript.
 *
 * Captured examples: `◆ Thought for 0.2s`, `◆ user_prompt_submit  [hooks: 3/1]`,
 * `◆ stop  [hooks: 3/1]`, `◆ List .  [hooks: 3]`.
 */
const SILVER = "var(--terminal-secondary)"; // 38;5;7 — ◆ event diamonds
const FG = "var(--terminal-foreground)";
const MUTED = "var(--terminal-muted)";
const DIM = "var(--terminal-muted)";
const GREEN = "var(--terminal-success)"; // 38;5;10 — successful hook counts

export function GrokEvent({
  label,
  hooks,
  hooksOk,
  elapsed,
  className,
  children,
}: {
  label: string;
  /** Total hooks fired, e.g. 3. */
  hooks?: number;
  /** Successful hooks when shown as `3/1`. */
  hooksOk?: number;
  /** Optional elapsed suffix, e.g. `0.2s` → "Thought for 0.2s" style via label. */
  elapsed?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const hooksText =
    hooks == null ? null : hooksOk != null ? null : ( // rendered with split colors below
      <span style={{ color: DIM }}>
        [hooks: <span style={{ color: GREEN }}>{hooks}</span>]
      </span>
    );

  return (
    <div
      className={cn(
        "flex flex-wrap items-baseline gap-x-2 font-mono text-[13px] leading-[1.55]",
        className,
      )}
    >
      <span aria-hidden style={{ color: SILVER }}>
        ◆
      </span>
      <span style={{ color: FG }}>
        {label}
        {elapsed ? (
          <>
            {" "}
            <span style={{ color: MUTED }}>{elapsed}</span>
          </>
        ) : null}
      </span>
      {hooks != null && hooksOk != null ? (
        <span style={{ color: DIM }}>
          [hooks: <span style={{ color: GREEN }}>{hooks}</span>
          <span>/{hooksOk}</span>]
        </span>
      ) : (
        hooksText
      )}
      {children}
    </div>
  );
}
