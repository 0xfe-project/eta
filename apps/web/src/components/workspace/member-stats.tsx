import type { MemberSpend } from "@eta/client-contracts";
import { displayContext, displaySpend } from "@eta/client-contracts";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useSession, useSessionActions } from "@/queries/sessions";

/**
 * What one member's session has spent and is chasing — the numbers that belong to a member rather
 * than to the group.
 *
 * Read from that member's own session (`sessions.<id>`: `usage`, `metrics`, `tools`, `goal`),
 * which is why it lives beside the member rather than in a group-level block: a group of three has
 * three of these, and each is about what that agent is doing here.
 */
export function MemberStats({
  sessionId,
  inline = false,
  className,
}: {
  sessionId: string | undefined;
  /** One line instead of a block: for a header that has a single row to give. */
  inline?: boolean;
  className?: string;
}) {
  const { t: translateText, i18n } = useTranslation([
    "chat",
    "common",
  ] as const);
  const session = useSession(sessionId);
  const { goal: setGoal } = useSessionActions();
  if (sessionId === undefined)
    return (
      <p className={`font-mono text-[10px] text-faint ${className ?? ""}`}>
        {translateText("chat:groups.members.noSession")}
      </p>
    );
  const { spend, goal, tools, model } = session ?? {};
  const count = (key: keyof MemberSpend) =>
    displaySpend(spend?.[key], i18n.language);
  const context = displayContext(session?.context, sessionId, i18n.language);
  const rate = Math.round((session?.metrics?.tokensPerSec ?? 0) * 10) / 10;
  const act = (action: "pause" | "resume" | "clear") =>
    setGoal.mutate(
      { session: sessionId, action },
      { onError: (error) => toast.error(error.message) },
    );
  if (inline)
    return (
      // The same numbers on one line, and the model not among them: a model id is a name, not a
      // count, and it is the one field here that can run longer than the whole row. It keeps its
      // place in the title. What is left — the spend, the tool count, the rate — truncates as one
      // run of text, so a narrow sidebar loses the tail of the numbers rather than the name of the
      // agent this card is about.
      <span
        title={model?.id}
        className={`flex min-w-0 items-baseline gap-2 font-mono text-[10px] text-muted-foreground tabular-nums ${className ?? ""}`}
      >
        <span className="min-w-0 truncate">
          <span title={context.detail}>{context.label}</span> · in{" "}
          <span className="text-foreground">{count("input")}</span> · out{" "}
          <span className="text-foreground">{count("output")}</span> · cache{" "}
          <span className="text-foreground">{count("cache")}</span>
          {" · "}
          {tools === undefined ? "tools —" : `tools ${tools.length}`}
        </span>
        {rate === 0 ? null : (
          <span className="shrink-0 text-state-success">{rate} tok/s</span>
        )}
      </span>
    );
  return (
    <div className="space-y-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
      <p className="truncate" title={model?.id}>
        {model?.id ?? "—"}
      </p>
      {/* The spend, with the rate at the end of the same line: "how much" and "how fast right
          now" are one question, and the rate is the half that proves the session is alive. */}
      <p className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate">
          <span title={context.detail}>{context.label}</span> · in{" "}
          <span className="text-foreground">{count("input")}</span> · out{" "}
          <span className="text-foreground">{count("output")}</span> · cache{" "}
          <span className="text-foreground">{count("cache")}</span>
        </span>
        {rate === 0 ? null : (
          <span className="shrink-0 text-state-success">{rate} tok/s</span>
        )}
      </p>
      <p>{tools === undefined ? "tools —" : `tools ${tools.length}`}</p>
      {goal === undefined ? null : (
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
          {goal.status === "achieved" ? null : (
            <button
              type="button"
              className="shrink-0 hover:text-foreground"
              onClick={() => act(goal.status === "active" ? "pause" : "resume")}
            >
              {goal.status === "active"
                ? translateText("common:actions.pause")
                : translateText("common:actions.resume")}
            </button>
          )}
          <button
            type="button"
            className="shrink-0 hover:text-foreground"
            onClick={() => act("clear")}
          >
            ×
          </button>
        </p>
      )}
    </div>
  );
}
