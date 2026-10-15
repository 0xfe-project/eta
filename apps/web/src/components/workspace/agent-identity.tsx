import type { Agent } from "@/queries/chat";
import { Blobatar } from "@blobatar/react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { agentStatusLabels } from "./agent-status";

/**
 * The agent's face, generated from its id so a rename keeps it. `animate`
 * makes it blink and breathe: for the one large avatar, not for lists.
 * Decorative; the name always sits beside it.
 */
export function AgentAvatar({
  agent,
  animate = false,
  className,
}: {
  agent: Pick<Agent, "id">;
  animate?: boolean;
  className?: string;
}) {
  const classes = cn("size-8 shrink-0", className);
  return animate ? (
    <Blobatar
      name={agent.id}
      animate="always"
      aria-hidden="true"
      className={classes}
    />
  ) : (
    <Blobatar name={agent.id} alt="" aria-hidden="true" className={classes} />
  );
}

export function AgentStatusDot({
  status,
  className,
}: {
  status: Agent["status"];
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-1.5 shrink-0",
        status === "idle" && "bg-muted-foreground/40",
        status === "starting" &&
          "bg-muted-foreground motion-safe:animate-pulse",
        status === "working" && "bg-foreground motion-safe:animate-pulse",
        status === "waiting_for_input" && "border border-foreground",
        status === "unavailable" && "bg-destructive",
        className,
      )}
    />
  );
}

export function AgentStatus({ status }: { status: Agent["status"] }) {
  useTranslation(["agents", "common"] as const);
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <AgentStatusDot status={status} />
      {agentStatusLabels[status]}
    </span>
  );
}
