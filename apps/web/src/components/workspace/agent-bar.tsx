import type { Group } from "@/queries/chat";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
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
import { CwdChip } from "./cwd-chip";
import { useAgents, useOpenAgent } from "./use-agents";
import { useGroups, useOpenGroup } from "./use-groups";
import { useHoverMenu } from "./use-hover-menu";

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
  const { t: translateText } = useTranslation([
    "agents",
    "chat",
    "common",
  ] as const);
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
    ? translateText("chat:agentSwitcher.currentDirectChat", {
        agentName: agent.name,
        status: agentStatusLabels[agent.status],
      })
    : translateText("chat:agentSwitcher.currentGroup", {
        groupName: group.name,
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
                {translateText("chat:groups.nameLabel", { name: group.name })}
              </span>
              <CheckIcon aria-label={translateText("common:labels.current")} />
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {translateText("chat:groups.directChat")}
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
                <CheckIcon
                  aria-label={translateText("common:labels.current")}
                />
              ) : null}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onInfo}>
          <InfoIcon aria-hidden="true" />
          {direct
            ? translateText("settings.title")
            : translateText("chat:groups.info")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openEditor()}>
          <PlusIcon aria-hidden="true" />
          {translateText("actions.create")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The chat's header: what this conversation is, where it works, and who is in it.
 *
 * Three things, in that order, in one row — and nothing else. It used to be a floating band of
 * avatars *inside* the transcript: not a header, so it scrolled with the text, spent the top of
 * every conversation on decoration, and read as content rather than as navigation. A header that
 * scrolls away is not a header.
 *
 * The avatar row is navigation: pressing one opens that agent's own conversation. The name opens
 * the switcher (other groups, the agent's editor). The folder chip says where the work happens.
 */
export function ChatHeader({
  group,
  onInfo,
  onOpenWorkspace,
  workspaceOpen,
}: {
  group?: Group;
  onInfo: () => void;
  /** Shown only when the panel is folded away (narrow desktop, or collapsed). */
  onOpenWorkspace?: () => void;
  workspaceOpen?: boolean;
}) {
  const { t: translateText } = useTranslation(["chat", "navigation"] as const);
  const openAgent = useOpenAgent();
  const members = group?.participants.filter((p) => p.member) ?? [];
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b px-2">
      <h1 className="flex min-w-0 items-center text-sm font-medium">
        {group ? (
          <AgentSwitch group={group} onInfo={onInfo}>
            {(openLabel) => (
              <button
                type="button"
                aria-label={openLabel}
                className="flex h-9 min-w-0 items-center gap-1 px-1 outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <span className="max-w-56 truncate">{group.name}</span>
                <CaretDownIcon
                  aria-hidden="true"
                  className="size-3 shrink-0 text-muted-foreground"
                />
              </button>
            )}
          </AgentSwitch>
        ) : null}
      </h1>
      <CwdChip group={group} />
      <span className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {members.map((member) => (
          <button
            key={member.agent_id}
            type="button"
            title={translateText("chat:groups.members.talkAlone", {
              name: member.name,
            })}
            onClick={() => openAgent(member.agent_id)}
            className="shrink-0 outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <AgentAvatar agent={{ id: member.agent_id }} className="size-5" />
          </button>
        ))}
      </span>
      {workspaceOpen === false && onOpenWorkspace !== undefined ? (
        <Button
          size="icon"
          variant="ghost"
          aria-label={translateText("navigation:actions.openWorkspace")}
          onClick={onOpenWorkspace}
        >
          <InfoIcon aria-hidden="true" />
        </Button>
      ) : null}
      <Button
        size="icon"
        variant="ghost"
        aria-label={translateText("chat:groups.info")}
        onClick={onInfo}
      >
        <InfoIcon aria-hidden="true" />
      </Button>
    </header>
  );
}
