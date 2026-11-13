import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * What a state colour is for: a 6px square beside the word that says the state. Never a fill or a
 * border on the thing itself — eta is grey, and a colour only says failed (error), needs a person
 * (warning) or done (success). Waiting for you to press a button is none of those: it is `neutral`.
 */
export type StateTone = "error" | "warning" | "success" | "neutral";

export function StateMark({
  tone,
  children,
  className,
}: {
  tone: StateTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      data-tone={tone}
      className={cn("inline-flex items-center gap-1.5", className)}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0",
          tone === "error" && "bg-state-error",
          tone === "warning" && "bg-state-warning",
          tone === "success" && "bg-state-success",
          tone === "neutral" && "bg-faint",
        )}
      />
      {children}
    </span>
  );
}
