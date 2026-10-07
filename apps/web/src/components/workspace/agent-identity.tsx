import type { Agent } from "@/queries/chat";
import { cn } from "@/lib/utils";

export const agentStatusLabels: Record<Agent["status"], string> = {
  idle: "空闲",
  working: "工作中",
  waiting_for_input: "等待确认",
  unavailable: "不可用",
};

/** Square monogram; the theme is monochrome, so status lives in the dot. */
export function AgentMonogram({
  agent,
  className,
}: {
  agent: Pick<Agent, "name">;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center bg-muted text-sm font-semibold text-foreground",
        className,
      )}
    >
      {Array.from(agent.name.trim())[0]?.toUpperCase() ?? "?"}
    </span>
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
        status === "working" && "bg-foreground motion-safe:animate-pulse",
        status === "waiting_for_input" && "border border-foreground",
        status === "unavailable" && "bg-destructive",
        className,
      )}
    />
  );
}

export function AgentStatus({ status }: { status: Agent["status"] }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <AgentStatusDot status={status} />
      {agentStatusLabels[status]}
    </span>
  );
}
