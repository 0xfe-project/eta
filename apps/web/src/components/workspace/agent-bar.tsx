import type {
  ConversationInfo,
  ConversationSummary,
  ProjectView,
} from "@eta/client-contracts";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
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
import { agentName, useAgentList } from "@/queries/agents";
import { AgentAvatar, AgentStatusDot } from "./agent-identity";
import { agentStatusLabels } from "./agent-status";
import { ProjectChip } from "./project-chip";
import { StewardChip } from "./steward-chip";
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
  group: ConversationSummary;
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
    group.kind === "direct" ? group.participants[0]?.agentId : undefined;
  const agent = agents.find((a) => a.id === direct);
  const directs = new Map(
    groups
      .filter((g) => g.kind === "direct")
      .map((g) => [g.participants[0]?.agentId, g.id]),
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
  info,
  project,
  onInfo,
  onOpenWorkspace,
  workspaceOpen,
}: {
  group?: ConversationSummary;
  /** The conversation's own facts (its steward override); not there until its target arrives. */
  info?: ConversationInfo | undefined;
  project?: ProjectView | undefined;
  onInfo: () => void;
  /** Shown only when the panel is folded away (narrow desktop, or collapsed). */
  onOpenWorkspace?: () => void;
  workspaceOpen?: boolean;
}) {
  const { t: translateText } = useTranslation(["chat", "navigation"] as const);
  const openAgent = useOpenAgent();
  const { agents } = useAgentList();
  const members = group?.participants ?? [];
  return (
    <header className="band gap-2 px-2">
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
      <ProjectChip project={project} />
      <StewardChip info={info} project={project} />
      <span className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {members.map((member) => (
          <button
            key={member.agentId}
            type="button"
            title={translateText("chat:groups.members.talkAlone", {
              name: agentName(agents, member.agentId),
            })}
            onClick={() => openAgent(member.agentId)}
            className="shrink-0 outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <AgentAvatar agent={{ id: member.agentId }} className="size-5" />
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
    </header>
  );
}

/**
 * The phone's header: three things, and the row is 44 pixels tall.
 *
 * Back (to the list, or to the chat when the panel is showing), the name, and the way to what
 * this conversation is. No avatar row and no folder chip: on a phone those belong in the panel
 * and in the chat itself, and squeezing them in here would cost the name the room it needs.
 */
export function MobileChatHeader({
  name,
  onBack,
  backLabel,
  onInfo,
  infoLabel,
}: {
  name: string;
  onBack: () => void;
  backLabel: string;
  onInfo: () => void;
  infoLabel: string;
}) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 md:hidden">
      <Button
        size="icon"
        variant="ghost"
        aria-label={backLabel}
        onClick={onBack}
      >
        <ArrowLeftIcon aria-hidden="true" />
      </Button>
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{name}</h1>
      <Button
        size="icon"
        variant="ghost"
        aria-label={infoLabel}
        onClick={onInfo}
      >
        <InfoIcon aria-hidden="true" />
      </Button>
    </header>
  );
}
