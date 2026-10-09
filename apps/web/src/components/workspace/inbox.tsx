import { BellIcon } from "@phosphor-icons/react/Bell";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Empty, LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  chatQueryOptions,
  useAnswerInteraction,
  usePendingInteractions,
} from "@/queries/chat";
import { useAgents, useOpenAgent } from "./use-agents";

/** Every agent's pending confirmations, answerable from anywhere. */
export function Inbox() {
  const { data, error, refetch } = useQuery(chatQueryOptions());
  const pending = usePendingInteractions();
  const { agents } = useAgents();
  const openAgent = useOpenAgent();
  const answer = useAnswerInteraction();

  if (error)
    return (
      <LoadError what="确认请求" error={error} onRetry={() => void refetch()} />
    );
  if (!data) return <Loading />;
  if (pending.length === 0)
    return (
      <Empty icon={BellIcon} title="没有待确认的请求">
        智能体要做需要你批准的操作时，会在这里等你答复。
      </Empty>
    );

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
