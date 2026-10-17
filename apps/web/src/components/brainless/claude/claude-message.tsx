import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A conversation turn.
 *
 * The two halves are told apart by where they sit, not by a label: what you said is on the right
 * and carries a background; what the agent said is on the left with none. That is eta-old's rule
 * (`justify-end`, accent field, `max-w-[80%]`), and it is the reason a long conversation is
 * readable at a glance — you can find your own question without reading a single word of it.
 *
 * Multi-agent groups add one thing: the assistant half can name who is speaking, because there the
 * question "which of them said this" is real. A single-agent conversation passes nothing and gets
 * the plain block.
 */
export function ClaudeMessage({
  role = "assistant",
  author,
  className,
  children,
}: {
  role?: "user" | "assistant";
  /** Who said it, when the conversation has more than one possible speaker. */
  author?: string | undefined;
  className?: string;
  children: React.ReactNode;
}) {
  if (role === "user") {
    return (
      <div className={cn("flex w-full min-w-0 justify-end", className)}>
        <div
          className="max-w-[80%] min-w-0 border border-border bg-[var(--terminal-surface)] px-2 py-1 font-mono text-[13px] leading-[1.55] break-words"
          style={{ color: "var(--terminal-foreground)" }}
        >
          {children}
        </div>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "font-mono text-[13px] leading-[1.6] text-[var(--terminal-claude-foreground)]",
        className,
      )}
    >
      {author === undefined ? null : (
        <span className="mb-0.5 block font-mono text-[10px] tracking-[0.08em] text-[var(--terminal-muted)] uppercase">
          {author}
        </span>
      )}
      {children}
    </div>
  );
}
