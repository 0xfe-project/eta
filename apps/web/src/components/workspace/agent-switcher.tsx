import { CaretUpDownIcon } from "@phosphor-icons/react/CaretUpDown";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AgentMonogram, AgentStatus, AgentStatusDot } from "./agent-identity";
import { useAgents } from "./use-agents";
import { useWorkspace } from "./workspace-state";

export function AgentSwitcher() {
  const { agents, current, select, loaded } = useAgents();
  const { setSettings } = useWorkspace();
  const openAgents = (creating: boolean) =>
    setSettings({ open: true, section: "agents", creating });

  if (!loaded) return null;
  if (!current)
    return (
      <Button size="sm" onClick={() => openAgents(true)}>
        <PlusIcon aria-hidden="true" data-icon="inline-start" />
        新建智能体
      </Button>
    );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-9 max-w-56 gap-2 px-1.5"
          aria-label={`当前智能体：${current.name}，切换智能体`}
        >
          <AgentMonogram agent={current} className="size-6 text-xs" />
          <span className="truncate text-sm font-medium">{current.name}</span>
          <AgentStatusDot status={current.status} />
          <CaretUpDownIcon
            aria-hidden="true"
            className="text-muted-foreground"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>切换智能体</DropdownMenuLabel>
        {agents.map((agent) => (
          <DropdownMenuItem key={agent.id} onSelect={() => select(agent.id)}>
            <AgentMonogram agent={agent} className="size-6 text-xs" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{agent.name}</span>
              <AgentStatus status={agent.status} />
            </span>
            {agent.id === current.id ? (
              <CheckIcon aria-label="当前" className="text-foreground" />
            ) : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openAgents(true)}>
          <PlusIcon aria-hidden="true" />
          新建智能体
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openAgents(false)}>
          <GearSixIcon aria-hidden="true" />
          管理智能体
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
