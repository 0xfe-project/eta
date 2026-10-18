import type { Interaction } from "@/queries/chat";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * What is waiting on you, above the conversation.
 *
 * A question raised inside a run sits in the timeline where it was asked — which is right when you
 * are reading that part. The strip is for the other case: you scrolled away, or the question came
 * from a member whose message is off screen. So it says who is asking and what about, in one line,
 * and lets you answer from there.
 *
 * It is not a notification centre: no count of things you could deal with later, no items that are
 * not blocking a run. Everything here is a run standing still until you press something.
 */
export function PendingStrip({
  interactions,
  agents,
  onAnswer,
}: {
  interactions: readonly Interaction[];
  /** Names by agent id: "who is asking" is the first thing the line has to say. */
  agents: readonly { id: string; name: string }[];
  onAnswer: (interactionId: string, value: string) => void;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const pending = interactions.filter(
    (interaction) => interaction.status === "pending",
  );
  if (pending.length === 0) return null;
  const nameOf = (agentId: string) =>
    agents.find((agent) => agent.id === agentId)?.name ?? agentId;
  return (
    <div
      role="status"
      aria-label={translateText("chat:pending.title")}
      className="mx-[1ch] mb-1 border border-state-warning px-2 py-1 text-xs"
    >
      {pending.slice(0, 3).map((interaction) => (
        <div
          key={interaction.id}
          className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 py-0.5")}
        >
          <span className="shrink-0 font-mono text-[10px] tracking-[0.08em] text-state-warning uppercase">
            {nameOf(interaction.agent_id)}
          </span>
          <span
            className="min-w-0 flex-1 truncate font-mono text-[11px]"
            title={interaction.prompt}
          >
            {interaction.prompt}
          </span>
          {interaction.options.map((option) => (
            <Button
              key={option.value}
              size="xs"
              variant="outline"
              onClick={() => onAnswer(interaction.id, option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      ))}
      {pending.length > 3 ? (
        <p className="pt-0.5 font-mono text-[10px] text-muted-foreground">
          {translateText("chat:pending.more", { count: pending.length - 3 })}
        </p>
      ) : null}
    </div>
  );
}
