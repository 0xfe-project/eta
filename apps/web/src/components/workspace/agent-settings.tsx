import { useState } from "react";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { Agent } from "@/queries/chat";
import { useModelAvailability } from "@/queries/llm";
import { DeleteAgentDialog } from "./agent-editor";
import { AgentMonogram, AgentStatus } from "./agent-identity";
import { useAgents } from "./use-agents";

function AgentRow({ agent, current }: { agent: Agent; current: boolean }) {
  const { select, openEditor, modelRequired } = useAgents();
  const [confirming, setConfirming] = useState(false);
  const instructions = agent.description.trim();
  const availability = useModelAvailability(agent, modelRequired);
  const modelName =
    availability.state === "not_set"
      ? "未选择模型"
      : (availability.model?.display_name ?? agent.model);

  return (
    <li
      className={cn(
        "flex items-start gap-3 px-3 py-2.5 transition-colors duration-[60ms] ease-linear",
        current ? "bg-accent" : "hover:bg-muted/60",
      )}
    >
      <AgentMonogram
        agent={agent}
        className={current ? "bg-foreground text-background" : undefined}
      />
      <button
        type="button"
        onClick={() => openEditor(agent.id)}
        aria-label={`编辑 ${agent.name}`}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left outline-none focus-visible:underline"
      >
        <span className="flex max-w-full items-center gap-2">
          <span className="truncate text-sm font-medium">{agent.name}</span>
          {current ? <Badge variant="secondary">当前</Badge> : null}
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
                : "text-destructive",
            )}
            title={
              availability.state === "unavailable"
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
          <DropdownMenuItem
            disabled={current}
            onSelect={() => select(agent.id)}
          >
            <CheckIcon aria-hidden="true" />
            设为当前
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openEditor(agent.id)}>
            <PencilSimpleIcon aria-hidden="true" />
            编辑
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
  const { agents, current, openEditor } = useAgents();

  if (agents.length === 0)
    return (
      <div className="flex flex-col items-center gap-3 border border-dashed px-6 py-10">
        <RobotIcon
          aria-hidden="true"
          className="size-8 text-muted-foreground"
        />
        <p className="text-sm font-medium">还没有智能体</p>
        <Button size="sm" onClick={() => openEditor()}>
          <PlusIcon aria-hidden="true" data-icon="inline-start" />
          新建智能体
        </Button>
      </div>
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
          <AgentRow
            key={agent.id}
            agent={agent}
            current={agent.id === current?.id}
          />
        ))}
      </ul>
    </div>
  );
}
