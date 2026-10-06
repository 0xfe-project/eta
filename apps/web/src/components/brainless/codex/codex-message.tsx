import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * CodexMessage — a Codex turn. User prompts show a bold `›` marker (default
 * foreground — not cyan); the assistant reply is plain text.
 */
export function CodexMessage({
  role = "assistant",
  className,
  children,
}: {
  role?: "user" | "assistant";
  className?: string;
  children: React.ReactNode;
}) {
  if (role === "user") {
    return (
      <div
        className={cn(
          "flex min-w-0 gap-2 font-mono text-[13px] leading-[1.6] text-[var(--terminal-foreground)]",
          className,
        )}
      >
        <span aria-hidden className="shrink-0 font-bold">
          ›
        </span>
        <span className="min-w-0 flex-1 break-words">{children}</span>
      </div>
    );
  }
  return (
    <div
      className={cn("font-mono text-[13px] leading-[1.6] text-[var(--terminal-secondary)]", className)}
    >
      {children}
    </div>
  );
}
