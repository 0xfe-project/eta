import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { Skeleton } from "@/components/states";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AgentAvatar, AgentStatusDot } from "./agent-identity";
import { agentStatusLabels } from "./agent-status";
import { useAgents } from "./use-agents";

// The avatar, with the name on a label overlapping its foot.
const avatar = "size-16";
const label =
  "relative -mt-2.5 flex max-w-48 items-center gap-1 border bg-background px-2.5 py-0.5 text-sm font-medium shadow-sm transition-colors duration-[60ms] ease-linear group-hover:bg-muted group-focus-visible:ring-1 group-focus-visible:ring-ring group-data-[state=open]:bg-muted motion-reduce:transition-none";

/** Atop the chat: who you are talking to, click to switch. */
export function AgentBar() {
  const { agents, current, loaded, error, select, openEditor } = useAgents();
  // The conversation below says what failed.
  if (error && !loaded) return null;
  return (
    <div className="flex shrink-0 justify-center px-3 pt-3 pb-2">
      {!loaded ? (
        <div role="status" className="flex flex-col items-center">
          <span className="sr-only">正在加载智能体…</span>
          <Skeleton className="size-16" />
          <Skeleton className="-mt-2.5 h-6 w-20" />
        </div>
      ) : current ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`正在与 ${current.name} 对话（${agentStatusLabels[current.status]}），切换智能体`}
              className="group flex max-w-full flex-col items-center outline-none"
            >
              <AgentAvatar agent={current} animate className={avatar} />
              <span className={label}>
                <AgentStatusDot status={current.status} />
                <span className="truncate">{current.name}</span>
                <CaretDownIcon
                  aria-hidden="true"
                  className="size-3 shrink-0 text-muted-foreground"
                />
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" className="w-56">
            {agents.map((agent) => (
              <DropdownMenuItem
                key={agent.id}
                onSelect={() => select(agent.id)}
              >
                <AgentAvatar agent={agent} className="size-5" />
                <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                {agent.id === current.id ? (
                  <CheckIcon aria-label="当前" />
                ) : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openEditor()}>
              <PlusIcon aria-hidden="true" />
              新建智能体
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <button
          type="button"
          onClick={() => openEditor()}
          className="group flex flex-col items-center outline-none"
        >
          <span
            aria-hidden="true"
            className={`${avatar} flex items-center justify-center border border-dashed bg-background text-muted-foreground`}
          >
            <PlusIcon />
          </span>
          <span className={label}>新建智能体</span>
        </button>
      )}
    </div>
  );
}
