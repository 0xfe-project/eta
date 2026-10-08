import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAnswerInteraction, usePendingInteractions } from "@/queries/chat";
import { useAgents } from "./use-agents";
import { useWorkspaceStore } from "./workspace-store";

/** Every agent's pending confirmations, answerable from anywhere. */
export function Inbox({ fullWindow }: { fullWindow: boolean }) {
  const pending = usePendingInteractions();
  const { agents, select } = useAgents();
  const setMobilePanel = useWorkspaceStore((s) => s.setMobilePanel);
  const navigate = useNavigate();
  const answer = useAnswerInteraction();

  if (pending.length === 0)
    return <p className="text-sm text-muted-foreground">没有待确认的请求</p>;

  const openAgent = (agentId: string) => {
    select(agentId);
    setMobilePanel("chat");
    if (fullWindow) void navigate({ to: "/" });
  };

  return (
    <ul className="space-y-3" aria-label="待确认的请求">
      {pending.map((interaction) => (
        <li key={interaction.id} className="space-y-2 border p-3">
          <Button
            variant="link"
            className="h-auto p-0 text-xs text-muted-foreground"
            onClick={() => openAgent(interaction.agent_id)}
          >
            {agents.find((agent) => agent.id === interaction.agent_id)?.name ??
              "智能体"}
          </Button>
          <p className="text-sm whitespace-pre-wrap">{interaction.prompt}</p>
          <div className="flex gap-2">
            {interaction.options.map((option, index) => (
              <Button
                key={option.value}
                size="sm"
                variant={index === 0 ? "default" : "outline"}
                disabled={answer.isPending}
                onClick={() =>
                  answer.mutate(
                    { id: interaction.id, value: option.value },
                    { onError: (error) => toast.error(error.message) },
                  )
                }
              >
                {option.label}
              </Button>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}
