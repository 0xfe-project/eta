import type { Group } from "@/queries/chat";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AgentAvatar, AgentStatusDot } from "./agent-identity";
import { agentStatusLabels } from "./agent-status";
import { useAgents } from "./use-agents";
import { useGroups, useOpenGroup } from "./use-groups";
import { useHoverMenu } from "./use-hover-menu";

// The avatar, with the name on a label overlapping its foot.
const label =
  "relative -mt-2.5 flex max-w-48 items-center gap-1 border bg-background px-2.5 py-0.5 text-sm font-medium shadow-sm transition-colors duration-[60ms] ease-linear group-hover:bg-muted group-focus-visible:ring-1 group-focus-visible:ring-ring group-data-[state=open]:bg-muted motion-reduce:transition-none";

/**
 * Switches the chat to an agent's direct chat, or keeps the group open. Only
 * navigates: the group's members, the agents' models and every chat's draft
 * and running replies stay as they are.
 */
function AgentSwitch({
  group,
  onInfo,
  children,
}: {
  group: Group;
  onInfo: () => void;
  children: (open: string) => React.ReactNode;
}) {
  const { t: translateText } = useTranslation();
  const { agents, openEditor } = useAgents();
  const { groups } = useGroups();
  const openGroup = useOpenGroup();
  const menu = useHoverMenu();
  const direct =
    group.kind === "direct"
      ? group.participants.find((p) => p.member)?.agent_id
      : undefined;
  const agent = agents.find((a) => a.id === direct);
  const directs = new Map(
    groups
      .filter((g) => g.kind === "direct")
      .map((g) => [g.participants.find((p) => p.member)?.agent_id, g.id]),
  );
  const open = agent
    ? translateText("正在与 {{value1}} 私聊（{{value2}}），切换智能体", {
        value1: agent.name,
        value2: agentStatusLabels[agent.status],
      })
    : translateText("正在群「{{value1}}」中，切换到智能体私聊", {
        value1: group.name,
      });
  return (
    <DropdownMenu {...menu.root}>
      <DropdownMenuTrigger asChild {...menu.trigger}>
        {children(open)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-56" {...menu.content}>
        {direct ? null : (
          <>
            <DropdownMenuItem>
              <span className="min-w-0 flex-1 truncate">
                {translateText("群 · {{value1}}", { value1: group.name })}
              </span>
              <CheckIcon aria-label={translateText("当前")} />
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {translateText("私聊")}
        </DropdownMenuLabel>
        {agents.map((a) => {
          const target = directs.get(a.id);
          return (
            <DropdownMenuItem
              key={a.id}
              disabled={!target}
              onSelect={() => {
                if (target && target !== group.id) openGroup(target);
              }}
            >
              <AgentAvatar agent={a} className="size-5" />
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
              <AgentStatusDot status={a.status} />
              {a.id === direct ? (
                <CheckIcon aria-label={translateText("当前")} />
              ) : null}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onInfo}>
          <InfoIcon aria-hidden="true" />
          {direct ? translateText("智能体设置") : translateText("群信息")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openEditor()}>
          <PlusIcon aria-hidden="true" />
          {translateText("新建智能体")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Atop the chat: who you are talking to, hover or click to switch. */
export function AgentBar({
  group,
  onInfo,
}: {
  group?: Group;
  onInfo: () => void;
}) {
  return (
    <div className="hidden shrink-0 justify-center px-3 pt-3 pb-2 md:flex">
      {group && (
        <AgentSwitch group={group} onInfo={onInfo}>
          {(open) => (
            <button
              type="button"
              aria-label={open}
              className="group flex max-w-full flex-col items-center outline-none"
            >
              <span className="flex -space-x-6">
                {group.participants
                  .filter((p) => p.member)
                  .slice(0, 3)
                  .map((p) => (
                    <AgentAvatar
                      key={p.agent_id}
                      agent={{ id: p.agent_id }}
                      animate={group.kind === "direct"}
                      className="size-16"
                    />
                  ))}
              </span>
              <span className={label}>
                <span className="truncate">{group.name}</span>
                <CaretDownIcon
                  aria-hidden="true"
                  className="size-3 shrink-0 text-muted-foreground"
                />
              </span>
            </button>
          )}
        </AgentSwitch>
      )}
    </div>
  );
}

/** The phone header's title, tapped to switch. */
export function AgentTitle({
  group,
  onInfo,
}: {
  group?: Group;
  onInfo: () => void;
}) {
  return (
    <h1 className="flex min-w-0 flex-1 text-sm font-medium">
      {group && (
        <AgentSwitch group={group} onInfo={onInfo}>
          {(open) => (
            <button
              type="button"
              aria-label={open}
              className="flex h-9 min-w-0 items-center gap-1 px-1 outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span className="truncate">{group.name}</span>
              <CaretDownIcon
                aria-hidden="true"
                className="size-3 shrink-0 text-muted-foreground"
              />
            </button>
          )}
        </AgentSwitch>
      )}
    </h1>
  );
}
