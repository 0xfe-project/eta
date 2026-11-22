import type { AgentView, AgentStatus as Status } from "@eta/client-contracts";
import { Blobatar } from "@blobatar/react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useAgentList } from "@/queries/agents";
import { agentStatusLabels } from "./agent-status";

/**
 * The agent's face, drawn from its avatar seed, or from its id when it never
 * drew one, so a rename keeps it. A caller that holds only the id gets the
 * seed from the agent list. `animate` makes it blink and breathe: for the one
 * large avatar, not for lists. Decorative; the name always sits beside it.
 */
export function AgentAvatar({
  agent,
  animate = false,
  className,
}: {
  agent: Pick<AgentView, "id"> & Partial<Pick<AgentView, "avatarSeed">>;
  animate?: boolean;
  className?: string;
}) {
  const { agents } = useAgentList();
  const seed =
    (agent.avatarSeed === undefined
      ? agents.find((entry) => entry.id === agent.id)?.avatarSeed
      : agent.avatarSeed) ?? agent.id;
  const classes = cn("size-8 shrink-0", className);
  return animate ? (
    <Blobatar
      name={seed}
      animate="always"
      aria-hidden="true"
      className={classes}
    />
  ) : (
    <Blobatar name={seed} alt="" aria-hidden="true" className={classes} />
  );
}

export function AgentStatusDot({
  status,
  className,
}: {
  status: Status;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-1.5 shrink-0",
        status === "idle" && "bg-muted-foreground/40",
        status === "working" && "bg-foreground motion-safe:animate-pulse",
        status === "waiting_for_input" && "border border-foreground",
        className,
      )}
    />
  );
}

export function AgentStatus({ status }: { status: Status }) {
  useTranslation(["agents", "common"] as const);
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <AgentStatusDot status={status} />
      {agentStatusLabels[status]}
    </span>
  );
}
