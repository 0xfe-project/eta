import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A turn in the transcript: eta-old's `.message` + `.message-content` + `.message-footer`.
 *
 * The two halves are told apart by where they sit, not by a label: what you said is on the right
 * and carries a background; what the agent said is on the left with none. That is why a long
 * conversation is readable at a glance — you can find your own question without reading a word of
 * it.
 */
export function Message({
  role,
  className,
  footer,
  children,
}: {
  role: "user" | "assistant";
  className?: string;
  /** The time, and anything else that belongs under the text in the small mono line. */
  footer?: ReactNode;
  children: ReactNode;
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

/** A system row: who joined, what was compacted, what the goal became. Centred, one line. */
export function SystemMessage({ children }: { children: ReactNode }) {
  return <div className="system-message">{children}</div>;
}
