import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A conversation turn, in eta-old's markup.
 *
 * `.message` + `.message-content` are its class names and its numbers (72% max width for what you
 * said, full width for what the agent said, a footer line 4px under the text). Not an
 * interpretation of them: the CSS was ported with the names, so this file and graphite.css can be
 * read side by side.
 */
export function ClaudeMessage({
  role = "assistant",
  className,
  footer,
  children,
}: {
  role?: "user" | "assistant";
  className?: string;
  /** The time (and anything else) that belongs under the text, in the small mono line. */
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("message", role, className)}>
      <div className="message-content">{children}</div>
      {footer === undefined ? null : (
        <div className="message-footer">{footer}</div>
      )}
    </div>
  );
}
