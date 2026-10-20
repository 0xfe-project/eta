import type {
  AgentView,
  ConversationSummary,
  MemberView,
} from "@eta/client-contracts";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { agentName, useAgentList } from "@/queries/agents";
import { useConversationActions } from "@/queries/conversations";
import { useMachines } from "@/queries/projects";
import { useModels } from "@/queries/providers";
import { AgentAvatar, AgentStatusDot } from "./agent-identity";
import { agentStatusLabels } from "./agent-status";
import { useOpenAgent } from "./use-agents";
import { useChatList } from "./use-chat-list";
import { useOpenGroup } from "./use-groups";
import { useWorkspaceStore } from "./workspace-store";

/** "3m" / "5h" / "1d": the age of a conversation, at a glance. */
function humanizeAge(at: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** `~/Desktop/eta`, not `/Users/lemonhx/Desktop/eta`: the row's title has the whole path. */
function shortenPath(path: string, home: string | null): string {
  if (home !== null && path.startsWith(`${home}/`))
    return `~/${path.slice(home.length + 1)}`;
  if (home !== null && path === home) return "~";
  return path;
}

/**
 * The sidebar: groups in the space above, agents pinned to the bottom.
 *
 * Both are cards, because both are one thing you can enter — a group is a place (a directory, some
 * agents, a piece of work), an agent is a relationship. A card carries what the thing is: a group
 * says which conversation and which directory; an agent says which persona and which model.
 *
 * The agent shelf sits at the bottom of the column and folds down to a single row there, not to a
 * line under the groups: it is the other half of the sidebar, not the tail of the list. Borders do
 * the work of separating them — BR1 does not mind a line.
 */
export function ConversationList() {
  const { t: translateText } = useTranslation(["chat"] as const);
  const { directories, directs, current, loaded } = useChatList();
  const { machines } = useMachines();
  const setNewConversation = useWorkspaceStore(
    (state) => state.setNewConversation,
  );
  const setAgentEditor = useWorkspaceStore((state) => state.setAgentEditor);
  const collapsed = useWorkspaceStore(
    (state) => state.workspace.agentsCollapsed === true,
  );
  const setWorkspace = useWorkspaceStore((state) => state.setWorkspace);
  const open = useOpenGroup();
  const setFocusedAgent = useWorkspaceStore((state) => state.setFocusedAgent);
  const focusedAgentId = useWorkspaceStore((state) => state.focusedAgentId);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const home = machines.find((machine) => machine.kind === "primary")?.home;

  return (
    <>
      <SidebarGroup
        aria-labelledby="sidebar-groups"
        className="min-h-0 flex-1 overflow-y-auto pb-0"
      >
        <div className="flex items-center justify-between border-b px-2 pr-1 pb-1">
          <span
            id="sidebar-groups"
            className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase"
          >
            {translateText("chat:sections.groups")}
          </span>
          <button
            type="button"
            aria-label={translateText("chat:new.title")}
            title={translateText("chat:new.title")}
            onClick={() => setNewConversation({ open: true })}
            className="flex size-6 items-center justify-center border border-border text-muted-foreground hover:text-foreground"
          >
            <PlusIcon aria-hidden="true" className="size-3.5" />
          </button>
        </div>
        <SidebarMenu className="gap-1.5 py-1.5">
          {directories.length === 0 ? (
            loaded ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                {translateText("chat:groups.empty.title")}
              </p>
            ) : null
          ) : (
            directories.flatMap((directory) =>
              directory.conversations.map((conversation) => {
                const active = current?.id === conversation.id;
                return (
                  <GroupCard
                    key={conversation.id}
                    conversation={conversation}
                    path={directory.path}
                    home={home ?? null}
                    active={active}
                    // The open group shows its members; folding it away is a choice of its own.
                    open={expanded[conversation.id] ?? active}
                    onToggle={() =>
                      setExpanded((state) => ({
                        ...state,
                        [conversation.id]: !(state[conversation.id] ?? active),
                      }))
                    }
                    onOpen={() => open(conversation.id)}
                    focusedAgentId={focusedAgentId}
                    onOpenAgent={(agentId) =>
                      setFocusedAgent(
                        focusedAgentId === agentId ? null : agentId,
                      )
                    }
                  />
                );
              }),
            )
          )}
        </SidebarMenu>
      </SidebarGroup>
      <SidebarGroup
        aria-labelledby="sidebar-agents"
        className="mt-auto shrink-0 border-t pb-0"
      >
        <div className="flex items-center justify-between border-b pr-1 pb-1 pl-1">
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={() =>
              setWorkspace((state) => ({
                ...state,
                agentsCollapsed: !collapsed,
              }))
            }
            className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 pl-1 text-left"
          >
            {/* Up when folded away, because unfolding grows upwards from the bottom of the column. */}
            <CaretDownIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                collapsed ? "rotate-180" : undefined,
              )}
            />
            <span
              id="sidebar-agents"
              className="min-w-0 flex-1 truncate font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase"
            >
              {translateText("chat:sections.agents")}
            </span>
          </button>
          {/* The same control as the groups' one, in the same place: two pluses in one column that
              looked and behaved differently read as two different kinds of thing. */}
          <button
            type="button"
            aria-label={translateText("chat:sections.newAgent")}
            title={translateText("chat:sections.newAgent")}
            onClick={() => setAgentEditor({ open: true, agentId: null })}
            className="flex size-6 items-center justify-center border border-border text-muted-foreground hover:text-foreground"
          >
            <PlusIcon aria-hidden="true" className="size-3.5" />
          </button>
        </div>
        {collapsed ? null : (
          // Never more than two fifths of the screen: the agents are who you can talk to, the
          // groups are the work, and the work keeps the room.
          <div className="max-h-[40dvh] overflow-y-auto">
            <SidebarMenu className="gap-1.5 py-1.5">
              {directs.length === 0 ? (
                loaded ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">
                    {translateText("chat:sections.noAgents")}
                  </p>
                ) : null
              ) : (
                directs.map((entry) => (
                  <AgentCard
                    key={entry.agent.id}
                    agent={entry.agent}
                    unread={entry.conversation?.unread ?? 0}
                  />
                ))
              )}
            </SidebarMenu>
          </div>
        )}
      </SidebarGroup>
    </>
  );
}

/**
 * One group as a card: who is in it, what it is called, which conversation it is, where it runs.
 *
 * Three lines are always there. The directory line is the reason a group is not interchangeable
 * with any other: two groups can have the same name and work in different places. Only the member
 * list folds away.
 */
function GroupCard({
  conversation,
  path,
  home,
  active,
  open,
  onToggle,
  onOpen,
  onOpenAgent,
  focusedAgentId,
}: {
  conversation: ConversationSummary;
  path: string | undefined;
  home: string | null;
  active: boolean;
  open: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onOpenAgent: (agentId: string) => void;
  focusedAgentId: string | null;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const { update } = useConversationActions();
  const { agents } = useAgentList();
  const [draft, setDraft] = useState<string | null>(null);
  const onError = (error: Error) => toast.error(error.message);
  const commitRename = () => {
    const next = (draft ?? "").trim();
    setDraft(null);
    if (next.length === 0 || next === conversation.name) return;
    update.mutate({ conversationId: conversation.id, name: next }, { onError });
  };
  const members = conversation.participants;
  const nameOf = (agentId: string) => agentName(agents, agentId);
  const busy = members.filter((member) => member.status !== "idle");
  const directory = path ?? translateText("chat:sections.unknownDirectory");

  return (
    <SidebarMenuItem
      className={cn(
        "group/menu-item relative border border-border transition-colors duration-75",
        "hover:bg-sidebar-accent",
        active && "bg-sidebar-accent",
      )}
      data-active={active}
    >
      {draft === null ? (
        <>
          {/* The card's own click target, under everything: the caret and the ⋯ are controls of
           * their own, and a button cannot hold another button. */}
          <button
            type="button"
            data-sidebar="menu-button"
            data-active={active}
            title={conversation.name}
            onClick={onOpen}
            className="absolute inset-x-0 top-0 h-11 focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-hidden"
          >
            <span className="sr-only">{conversation.name}</span>
          </button>
          <div className="pointer-events-none relative z-10 px-2 pt-1.5">
            {/* The ⋯ is a corner control, not a column: the row ends before it. */}
            <div className="flex items-center gap-1.5 pr-6">
              <button
                type="button"
                aria-label={
                  open
                    ? translateText("chat:groups.members.collapse")
                    : translateText("chat:groups.members.expand")
                }
                aria-expanded={open}
                onClick={onToggle}
                className="pointer-events-auto flex size-5 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
              >
                <CaretDownIcon
                  aria-hidden="true"
                  className={cn(
                    "size-4 transition-transform",
                    !open && "-rotate-90",
                  )}
                />
              </button>
              <MemberStack members={members} />
              <span className="min-w-0 flex-1 truncate text-base leading-tight">
                {conversation.name}
              </span>
              {busy.length > 0 ? (
                <span
                  className="shrink-0 font-mono text-[10px] text-state-success"
                  title={busy.map((m) => nameOf(m.agentId)).join("、")}
                >
                  ●
                </span>
              ) : null}
              {conversation.unread > 0 ? (
                <span className="shrink-0 font-mono text-[10px] text-foreground tabular-nums">
                  {conversation.unread}
                </span>
              ) : null}
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {humanizeAge(
                  conversation.lastMessageAt ?? conversation.updatedAt,
                )}
              </span>
            </div>
            <p
              data-slot="conversation-id"
              title={conversation.id}
              className="truncate pt-0.5 pl-6 font-mono text-[10px] text-muted-foreground"
            >
              {conversation.id.slice(0, 13)}
            </p>
            <p
              data-slot="conversation-path"
              title={path}
              className="truncate pt-0.5 pl-6 pb-1.5 font-mono text-[10px] text-faint"
            >
              {shortenPath(directory, home)}
            </p>
          </div>
        </>
      ) : (
        <div className="relative z-10 px-2 py-2">
          <RenameField
            value={draft}
            onChange={setDraft}
            onCommit={commitRename}
            onCancel={() => setDraft(null)}
          />
        </div>
      )}
      <RowMenu
        onRename={() => setDraft(conversation.name)}
        archived={conversation.archived}
        onArchive={() =>
          update.mutate(
            {
              conversationId: conversation.id,
              archived: !conversation.archived,
            },
            { onError },
          )
        }
      />
      {open ? (
        <div className="relative z-10 border-t border-border">
          {/* The members are inside the group's own box: the line on the left is what makes them
           * read as belonging to the card rather than as more rows of the list. */}
          <span
            aria-hidden="true"
            className="absolute top-0 bottom-0 left-6 w-px bg-border"
          />
          <ul className="py-1">
            {members.map((member) => (
              <li key={member.agentId}>
                <button
                  type="button"
                  data-slot="member-row"
                  onClick={() => onOpenAgent(member.agentId)}
                  title={translateText("chat:groups.members.talkAlone", {
                    name: nameOf(member.agentId),
                  })}
                  className={cn(
                    "flex w-full items-center gap-2 py-1.5 pr-2 pl-9 text-left hover:bg-sidebar-accent",
                    focusedAgentId === member.agentId && "text-foreground",
                  )}
                >
                  <AgentAvatar
                    agent={{ id: member.agentId }}
                    className="size-5"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {nameOf(member.agentId)}
                  </span>
                  {member.status !== "idle" ? (
                    <span className="size-1.5 shrink-0 bg-state-success" />
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </SidebarMenuItem>
  );
}

/** One agent as a card: its name, and what it is wearing and running. */
function AgentCard({ agent, unread }: { agent: AgentView; unread: number }) {
  const { t: translateText } = useTranslation(["chat"] as const);
  const openAgent = useOpenAgent();
  const { data: models } = useModels();
  // The persona card it wears, by id, and the model it runs, as the picker names it. A model the
  // catalog does not know is left out rather than spelled out: half an id says less than nothing.
  const modelName =
    agent.model === null
      ? undefined
      : models?.find((model) => model.id === agent.model)?.name;
  const tags = [agent.persona, modelName].filter(
    (tag): tag is string => tag !== undefined && tag.length > 0,
  );
  return (
    <SidebarMenuItem className="border border-border transition-colors duration-75">
      <button
        type="button"
        data-sidebar="menu-button"
        title={translateText("chat:groups.members.talkAlone", {
          name: agent.name,
        })}
        onClick={() => openAgent(agent.id)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors duration-75 hover:bg-sidebar-accent"
      >
        <AgentAvatar agent={agent} className="size-6" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span data-slot="agent-name" className="truncate text-sm">
            {agent.name}
          </span>
          {tags.length > 0 ? (
            <span
              data-slot="agent-tags"
              className="truncate font-mono text-[10px] text-muted-foreground"
            >
              {tags.join(" · ")}
            </span>
          ) : null}
        </span>
        {unread > 0 ? (
          <span className="shrink-0 font-mono text-[10px] tabular-nums">
            {unread}
          </span>
        ) : (
          <AgentStatusDot status={agent.status} />
        )}
        <span className="sr-only">{agentStatusLabels[agent.status]}</span>
      </button>
    </SidebarMenuItem>
  );
}

/** The card's member avatars: as many as fit, then a count. */
function MemberStack({ members }: { members: readonly MemberView[] }) {
  const shown = members.slice(0, 3);
  const rest = members.length - shown.length;
  if (members.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center" aria-hidden="true">
      {/* No box behind them: a blob avatar is a filled shape with transparent surroundings, so a
       * wrapper is a dark frame in a dark theme — the frame is the bug, not the overlap. */}
      <span className="flex -space-x-1">
        {shown.map((member) => (
          <AgentAvatar
            key={member.agentId}
            agent={{ id: member.agentId }}
            className="size-5"
          />
        ))}
      </span>
      {rest > 0 ? (
        <span className="ml-1 shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
          +{rest}
        </span>
      ) : null}
    </span>
  );
}

function RowMenu({
  onRename,
  archived,
  onArchive,
}: {
  onRename: (() => void) | undefined;
  archived: boolean;
  onArchive: () => void;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuAction
          showOnHover
          aria-label={translateText("chat:groups.accessibility.actions")}
          className="top-1.5 right-1 z-20"
        >
          <DotsThreeIcon aria-hidden="true" />
        </SidebarMenuAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        {onRename === undefined ? null : (
          <DropdownMenuItem onSelect={onRename}>
            {translateText("chat:groups.actions.rename")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onArchive}>
          {archived
            ? translateText("chat:groups.actions.unarchive")
            : translateText("chat:groups.actions.archive")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Renaming in place: the card becomes the field, and Enter or leaving it commits. */
function RenameField({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  onChange: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { t: translateText } = useTranslation(["chat"] as const);
  return (
    <Input
      autoFocus
      aria-label={translateText("chat:groups.actions.rename")}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onCommit}
      onKeyDown={(event) => {
        if (event.key === "Enter") onCommit();
        if (event.key === "Escape") onCancel();
      }}
      className="h-8"
    />
  );
}
