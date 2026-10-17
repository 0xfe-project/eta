import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

/**
 * A member's token spend as one circle.
 *
 * The ring is the budget the member has used: the in half in one colour, the out half in another,
 * the rest of the circle the part of the conversation not theirs. In the middle, the agent's own
 * avatar — not a percentage of a context window we do not know per member — so the circle says
 * "this is 乐子人, and this is what 乐子人 cost", not "this is a number out of a number".
 *
 * The rate beside it is the work being visible: it comes from the session's transcript, which is
 * where the server knows it, and it is why the whole card polls at 300ms — a counter that moves
 * is the difference between "busy" and "stalled".
 */
export function MemberRing({
  sessionId,
  children,
}: {
  sessionId: string;
  children?: ReactNode;
}) {
  const { data: usage } = useQuery({
    queryKey: ["session-usage", sessionId],
    staleTime: 300,
    refetchInterval: 300,
    queryFn: async () => {
      const response = await fetch(`/sessions/${sessionId}/usage`);
      if (!response.ok) return null;
      return (await response.json()) as {
        input: number;
        output: number;
        cache_read: number;
        cache_write: number;
      };
    },
  });
  const total =
    usage === null || usage === undefined
      ? 0
      : usage.input + usage.output + usage.cache_read + usage.cache_write;
  const share = (part: number) => (total === 0 ? 0 : Math.min(1, part / total));
  return (
    <div className="flex items-center gap-3">
      <svg viewBox="0 0 44 44" className="size-11 shrink-0">
        <circle
          cx="22"
          cy="22"
          r="18"
          fill="none"
          stroke="var(--overlay)"
          strokeWidth="5"
        />
        {/* in: the model's reading. out: what it said. Two colours, two facts. */}
        <circle
          cx="22"
          cy="22"
          r="18"
          fill="none"
          stroke="var(--state-info)"
          strokeWidth="5"
          stroke-dasharray={`${share(usage?.input ?? 0) * 113} 113`}
          transform="rotate(-90 22 22)"
        >
          <title>{`in ~${(usage?.input ?? 0).toLocaleString()}`}</title>
        </circle>
        <circle
          cx="22"
          cy="22"
          r="18"
          fill="none"
          stroke="var(--state-warning)"
          strokeWidth="5"
          stroke-dasharray={`${share((usage?.output ?? 0) + (usage?.cache_write ?? 0)) * 113} 113`}
          stroke-dashoffset={-share(usage?.input ?? 0) * 113}
          transform="rotate(-90 22 22)"
        >
          <title>{`out ~${(usage?.output ?? 0).toLocaleString()}`}</title>
        </circle>
        {children}
      </svg>
    </div>
  );
}
