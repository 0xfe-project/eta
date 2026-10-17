import { useQuery } from "@tanstack/react-query";

/**
 * How fast the member is talking.
 *
 * One number from the transcript: the tokens of the last assistant message, divided by the
 * seconds it took. It is polled at the same 300ms as the ring beside it, because its whole job
 * is to move — a rate that ticks twice a minute is a stall indicator, not a rate.
 */
export function TokenRate({ sessionId }: { sessionId: string }) {
  const { data: rate } = useQuery({
    queryKey: ["session-rate", sessionId],
    staleTime: 300,
    refetchInterval: 300,
    queryFn: async (): Promise<number | null> => {
      const response = await fetch(`/sessions/${sessionId}/messages`);
      if (!response.ok) return null;
      const body = (await response.json()) as {
        messages?: {
          role: string;
          usage?: {
            output: number;
            totalTokens: number;
          };
          timestamp?: number;
        }[];
      };
      const last = [...(body.messages ?? [])]
        .reverse()
        .find((message) => message.role === "assistant" && message.usage);
      if (last === undefined || last.usage === undefined) return null;
      const seconds =
        last.timestamp === undefined
          ? null
          : (Date.now() - last.timestamp) / 1000;
      if (seconds === null || seconds <= 0) return null;
      const perSecond = last.usage.output / seconds;
      return Number.isFinite(perSecond) ? perSecond : null;
    },
  });
  if (rate === null || rate === undefined) return null;
  return (
    <span className="font-mono text-[11px] text-state-success tabular-nums">
      {(Math.round(rate * 10) / 10).toFixed(1)} tok/s
    </span>
  );
}
