import { useQuery } from "@tanstack/react-query";

/**
 * One member's session, as the numbers a card shows.
 *
 * `tokens_per_sec` is what the session is producing *now* — the harness measures it from the run's
 * own frames over a two-second window, so it falls back to 0 when the run ends instead of reporting
 * the average of a run that finished an hour ago.
 *
 * Polled at 300ms on purpose: the counter and the rate are the panel's proof that work is happening
 * right now, and a number that moves twice a minute reads as a stall.
 */
export interface SessionUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  turns: number;
  compactions: number;
  model: string | null;
  tokens_per_sec: number;
}

export function useSessionUsage(sessionId: string | undefined) {
  return useQuery({
    queryKey: ["session-usage", sessionId],
    enabled: sessionId !== undefined,
    staleTime: 300,
    refetchInterval: 300,
    queryFn: async (): Promise<SessionUsage | null> => {
      const response = await fetch(`/sessions/${sessionId}/usage`);
      if (!response.ok) return null;
      return (await response.json()) as SessionUsage;
    },
  });
}
