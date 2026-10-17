import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useGoal, useSetGoal } from "@/queries/chat";

/**
 * What one member's session has spent and is chasing — the numbers that belong to a member rather
 * than to the group.
 *
 * Read from that member's own session (`/sessions/{id}/usage|tools|goal`), which is why it lives
 * beside the member rather than in a group-level block: a group of three has three of these, and
 * each is about what that agent is doing here.
 */
export function MemberStats({ sessionId }: { sessionId: string | undefined }) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const { data: usage } = useQuery({
    queryKey: ["session-usage", sessionId],
    enabled: sessionId !== undefined,
    // Fast on purpose: the token counter and token/s are the panel's proof that work is
    // happening right now. A number that moves only every half minute reads as a stall.
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
        turns: number;
        model: string | null;
      };
    },
  });
  const { data: tools } = useQuery({
    queryKey: ["session-tools", sessionId],
    enabled: sessionId !== undefined,
    staleTime: 300,
    refetchInterval: 300,
    queryFn: async () => {
      const response = await fetch(`/sessions/${sessionId}/tools`);
      if (!response.ok) return null;
      return (await response.json()) as { tools: string[]; refused: number };
    },
  });
  const { data: goal } = useGoal(sessionId);
  const setGoal = useSetGoal();
  if (sessionId === undefined)
    return (
      <p className="font-mono text-[10px] text-faint">
        {translateText("chat:groups.members.noSession")}
      </p>
    );
  const tokens = (count: number | undefined) =>
    count === undefined
      ? "—"
      : count >= 1_000_000
        ? `${(count / 1_000_000).toFixed(1)}M`
        : count >= 1_000
          ? `${(count / 1_000).toFixed(1)}k`
          : String(count);
  return (
    <div className="space-y-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
      <p className="truncate" title={usage?.model ?? undefined}>
        {usage?.model ?? "—"}
      </p>
      <p>
        in {tokens(usage?.input)} · out {tokens(usage?.output)} · cache{" "}
        {tokens(
          usage === null || usage === undefined
            ? undefined
            : usage.cache_read + usage.cache_write,
        )}
      </p>
      <p>
        {tools === null || tools === undefined
          ? "tools —"
          : `tools ${tools.tools.length}${tools.refused > 0 ? ` · ${tools.refused} ${translateText("chat:tools.refused")}` : ""}`}
        {" · "}
        {translateText("chat:groups.members.turns", {
          count: usage?.turns ?? 0,
        })}
      </p>
      {goal === undefined || goal === null ? null : (
        <p className="flex items-center gap-1">
          <span
            className={
              goal.status === "active"
                ? "min-w-0 flex-1 truncate text-state-success"
                : "min-w-0 flex-1 truncate"
            }
            title={goal.objective}
          >
            {goal.objective}
          </span>
          <button
            type="button"
            className="shrink-0 hover:text-foreground"
            onClick={() =>
              void setGoal.mutateAsync({
                sessionId,
                action: goal.status === "active" ? "pause" : "resume",
              })
            }
          >
            {goal.status === "active"
              ? translateText("common:actions.pause")
              : translateText("common:actions.resume")}
          </button>
          <button
            type="button"
            className="shrink-0 hover:text-foreground"
            onClick={() =>
              void setGoal.mutateAsync({ sessionId, action: "clear" })
            }
          >
            ×
          </button>
        </p>
      )}
    </div>
  );
}
