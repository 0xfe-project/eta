import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AgentMonogram,
  AgentStatusDot,
  agentStatusLabels,
} from "./agent-identity";
import { useAgents } from "./use-agents";

const card =
  "flex h-9 items-center gap-2 border bg-background/95 px-2 text-sm shadow-md backdrop-blur outline-none transition-colors duration-[60ms] ease-linear hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none";

/** Floating card over the chat: who you are talking to, click to switch. */
export function AgentBar() {
  const { agents, current, loaded, select, openEditor } = useAgents();
  if (!loaded) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-3">
      {current ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`正在与 ${current.name} 对话（${agentStatusLabels[current.status]}），切换智能体`}
              className={`${card} pointer-events-auto max-w-full data-[state=open]:bg-muted`}
            >
              <AgentMonogram agent={current} className="size-6 text-xs" />
              <span className="truncate font-medium">{current.name}</span>
              <AgentStatusDot status={current.status} />
              <CaretDownIcon
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" className="w-56">
            {agents.map((agent) => (
              <DropdownMenuItem
                key={agent.id}
                onSelect={() => select(agent.id)}
              >
                <AgentMonogram agent={agent} className="size-5 text-[10px]" />
                <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                {agent.id === current.id ? (
                  <CheckIcon aria-label="当前" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <button
          type="button"
          onClick={() => openEditor()}
          className={`${card} pointer-events-auto`}
        >
          <PlusIcon aria-hidden="true" className="size-4" />
          新建智能体
        </button>
      )}
    </div>
  );
}
