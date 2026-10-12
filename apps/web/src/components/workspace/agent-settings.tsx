import type { Agent } from "@/queries/chat";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useState } from "react";
import { toast } from "sonner";
import { Empty, LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useRestartAgent } from "@/queries/chat";
import { useModelAvailability } from "@/queries/llm";
import { DeleteAgentDialog } from "./agent-editor";
import { AgentAvatar, AgentStatus } from "./agent-identity";
import { useAgents } from "./use-agents";

function AgentRow({ agent }: { agent: Agent }) {
  const { openEditor } = useAgents();
  const restart = useRestartAgent();
  const [confirming, setConfirming] = useState(false);
  const instructions = agent.description.trim();
  const availability = useModelAvailability(agent);
  const modelName =
    availability.state === "not_set"
      ? "未选择模型"
      : (availability.model?.display_name ?? agent.model);

  return (
    <li className="flex items-start gap-3 px-3 py-2.5 transition-colors duration-[60ms] ease-linear hover:bg-muted/60">
      <AgentAvatar agent={agent} />
      <button
        type="button"
        onClick={() => openEditor(agent.id)}
        aria-label={`编辑 ${agent.name}`}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left outline-none focus-visible:underline"
      >
        <span className="flex max-w-full items-center gap-2">
          <span className="truncate text-sm font-medium">{agent.name}</span>
          <span className="text-xs">
            <AgentStatus status={agent.status} />
          </span>
        </span>
        {modelName ? (
          <span
            className={cn(
              "inline-flex max-w-full items-center gap-1 text-xs",
              availability.state === "ok"
                ? "text-muted-foreground"
                : availability.state === "degraded"
                  ? "text-amber-600 dark:text-amber-500"
                  : "text-destructive",
            )}
            title={
              availability.state === "unavailable" ||
              availability.state === "degraded"
                ? availability.message
                : undefined
            }
          >
            {availability.state !== "ok" ? (
              <WarningIcon aria-hidden="true" className="size-3.5 shrink-0" />
            ) : null}
            <span className="truncate">{modelName}</span>
            {availability.state === "unavailable" ? (
              <span className="sr-only">：{availability.message}</span>
            ) : null}
          </span>
        ) : null}
        <span
          className={cn(
            "line-clamp-2 text-xs text-muted-foreground",
            !instructions && "opacity-60",
          )}
        >
          {instructions || "未设置指令"}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${agent.name} 的操作`}
          >
            <DotsThreeIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem onSelect={() => openEditor(agent.id)}>
            <PencilSimpleIcon aria-hidden="true" />
            编辑
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={restart.isPending}
            onSelect={() =>
              restart.mutate(agent.id, {
                onSuccess: () => toast.success(`已重启 ${agent.name}`),
                onError: (error) => toast.error(error.message),
              })
            }
          >
            <ArrowClockwiseIcon aria-hidden="true" />
            重启
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setConfirming(true)}
          >
            <TrashIcon aria-hidden="true" />
            删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteAgentDialog
        agent={agent}
        open={confirming}
        onOpenChange={setConfirming}
      />
    </li>
  );
}

export function AgentSettings() {
  const { agents, loaded, error, retry, openEditor } = useAgents();

  if (error && !loaded)
    return <LoadError what="智能体" error={error} onRetry={retry} />;
  if (!loaded) return <Loading />;
  if (agents.length === 0)
    return (
      <Empty
        icon={RobotIcon}
        title="还没有智能体"
        action={
          <Button size="sm" onClick={() => openEditor()}>
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            新建智能体
          </Button>
        }
      >
        智能体是你对话、交代任务的对象，每个都有自己的模型和记忆。
      </Empty>
    );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          智能体
          <span className="ml-1.5 font-normal tabular-nums text-muted-foreground">
            {agents.length}
          </span>
        </h2>
        <Button size="sm" onClick={() => openEditor()}>
          <PlusIcon aria-hidden="true" data-icon="inline-start" />
          新建
        </Button>
      </div>
      <ul aria-label="智能体列表" className="divide-y border">
        {agents.map((agent) => (
          <AgentRow key={agent.id} agent={agent} />
        ))}
      </ul>
    </div>
  );
}
