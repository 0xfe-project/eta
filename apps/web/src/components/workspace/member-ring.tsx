import type { ReactNode } from "react";
import { useSessionUsage } from "./session-usage";

/**
 * A member's spend, as a ring around the member's own avatar.
 *
 * The avatar was already the row's first thing; putting the gauge anywhere else made the row carry
 * two avatars, which is one avatar too many. So the ring wraps the one that was there: the reading
 * half of the conversation in one colour, the written half in another, and the part of the circle
 * left over is the share this member did not spend.
 *
 * Not a context-window percentage: a member's window is not something this page knows, and a
 * made-up denominator would make the ring look full when nothing is wrong.
 */
export function MemberRing({
  sessionId,
  children,
}: {
  sessionId: string;
  children: ReactNode;
}) {
  const { data: usage } = useSessionUsage(sessionId);
  const total =
    (usage?.input ?? 0) +
    (usage?.output ?? 0) +
    (usage?.cache_read ?? 0) +
    (usage?.cache_write ?? 0);
  const share = (part: number) => (total === 0 ? 0 : Math.min(1, part / total));
  // The circle's circumference at r=20 in this 48-unit box: the avatar (32px) sits inside it
  // with a gap, so the ring reads as around the avatar rather than as its border.
  const circumference = 2 * Math.PI * 20;
  const read = share(usage?.input ?? 0) * circumference;
  const written =
    share((usage?.output ?? 0) + (usage?.cache_write ?? 0)) * circumference;
  return (
    <span className="relative inline-flex size-12 shrink-0 items-center justify-center">
      <svg
        viewBox="0 0 48 48"
        aria-hidden="true"
        className="absolute inset-0 size-12 -rotate-90"
      >
        <circle
          cx="24"
          cy="24"
          r="20"
          fill="none"
          stroke="var(--overlay)"
          strokeWidth="3"
        />
        <circle
          cx="24"
          cy="24"
          r="20"
          fill="none"
          stroke="var(--state-info)"
          strokeWidth="3"
          strokeDasharray={`${read} ${circumference}`}
        />
        <circle
          cx="24"
          cy="24"
          r="20"
          fill="none"
          stroke="var(--state-warning)"
          strokeWidth="3"
          strokeDasharray={`${written} ${circumference}`}
          strokeDashoffset={-read}
        />
      </svg>
      {children}
    </span>
  );
}
