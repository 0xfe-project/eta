import type {
  AgentView,
  ConversationSummary,
  MemberView,
} from "@eta/client-contracts";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
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
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { agentName, useAgentList } from "@/queries/agents";
import { useConversationActions } from "@/queries/conversations";
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

/**
 * The sidebar's one list: everything you can chat with, newest activity first.
 *
 * Group chats and every agent (as its private chat) in a flat list; an agent that has not been
 * talked to yet comes last and opens its chat when pressed. What a row shows is the conversation,
 * not where it runs: a private chat shows its agent, a group its members. The project is chosen
 * when a conversation is made (`+`), not by a heading here.
 */
export function ConversationList() {
  const { t: translateText } = useTranslation(["chat"] as const);
  // Conversations newest activity first (`lastMessageAt`, else `updatedAt`), archived ones are
  // Settings'; then the agents with no chat yet.
  const { rows, current, loaded } = useChatList();
  const open = useOpenGroup();
  const navigate = useNavigate();
  const setFocusedAgent = useWorkspaceStore((state) => state.setFocusedAgent);
  const focusedAgentId = useWorkspaceStore((state) => state.focusedAgentId);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  return (
    <SidebarGroup aria-labelledby="sidebar-conversations">
      <SidebarGroupLabel
        id="sidebar-conversations"
        className="text-xs font-medium text-muted-foreground"
      >
        {translateText("chat:history.recentChats")}
      </SidebarGroupLabel>
      <SidebarGroupAction
        aria-label={translateText("chat:new.title")}
        title={translateText("chat:new.title")}
        onClick={() => void navigate({ to: "/new" })}
      >
        <PlusIcon aria-hidden="true" />
      </SidebarGroupAction>
      {rows.length === 0 ? (
        loaded ? (
          <p className="px-2 text-xs text-muted-foreground">
            {translateText("chat:groups.empty.title")}
          </p>
        ) : null
      ) : (
        <SidebarMenu>
          {rows.map((row) => {
            if (row.kind === "agent")
              return <AgentRow key={row.agent.id} agent={row.agent} />;
            const { conversation } = row;
            return (
              <GroupRow
                key={conversation.id}
                conversation={conversation}
                active={current?.id === conversation.id}
                expanded={expanded[conversation.id] === true}
                onToggle={() =>
                  setExpanded((state) => ({
                    ...state,
                    [conversation.id]: !state[conversation.id],
                  }))
                }
                onOpen={() => open(conversation.id)}
                // A member listed under a group is a member *of that group*: pressing it
                // narrows the conversation to it, the same action as its card in the panel.
                // Press to focus, press again to let go.
                onOpenAgent={(agentId) => {
                  setFocusedAgent(focusedAgentId === agentId ? null : agentId);
                  open(conversation.id);
                }}
              />
            );
          })}
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
}

/** An agent nobody has talked to yet: pressing it makes its private chat and opens it. */
function AgentRow({ agent }: { agent: AgentView }) {
  const { t: translateText } = useTranslation(["agents"] as const);
  const openAgent = useOpenAgent();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={() => openAgent(agent.id)}
        title={translateText("actions.chatWith", { name: agent.name })}
        className="h-9 text-sm"
      >
        <AgentAvatar agent={agent} className="size-5" />
        <span className="min-w-0 flex-1 truncate">{agent.name}</span>
        <AgentStatusDot status={agent.status} />
        <span className="sr-only">{agentStatusLabels[agent.status]}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** Whether a member is answering, or about to. */
const busyMember = (member: MemberView) => member.status !== "idle";

function GroupRow({
  conversation,
  active,
  expanded,
  onToggle,
  onOpen,
  onOpenAgent,
}: {
  conversation: ConversationSummary;
  active: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onOpenAgent: (agentId: string) => void;
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
  const direct = conversation.kind === "direct";
  const expandable = !direct && members.length > 0;
  const busy = members.filter(busyMember);

  return (
    <SidebarMenuItem>
      {draft === null ? (
        <SidebarMenuButton
          isActive={active}
          onClick={onOpen}
          title={conversation.name}
          className={cn("h-9 text-sm", expandable && "pr-14")}
        >
          <MemberStack members={members} />
          <span className="min-w-0 flex-1 truncate">{conversation.name}</span>
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
            {humanizeAge(conversation.lastMessageAt ?? conversation.updatedAt)}
          </span>
        </SidebarMenuButton>
      ) : (
        <div className="flex h-9 items-center px-2">
          <RenameField
            value={draft}
            onChange={setDraft}
            onCommit={commitRename}
            onCancel={() => setDraft(null)}
          />
        </div>
      )}
      {expandable ? (
        <SidebarMenuAction
          showOnHover
          aria-label={
            expanded
              ? translateText("chat:groups.members.collapse")
              : translateText("chat:groups.members.expand")
          }
          aria-expanded={expanded}
          onClick={onToggle}
          className="top-2 right-7"
        >
          <CaretRightIcon
            aria-hidden="true"
            className={cn(expanded && "rotate-90")}
          />
        </SidebarMenuAction>
      ) : null}
      <RowMenu
        // A private chat is named after its agent: the host renames it with the agent.
        onRename={direct ? undefined : () => setDraft(conversation.name)}
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
      {expandable && expanded ? (
        <SidebarMenuSub>
          {members.map((member) => (
            <SidebarMenuSubItem key={member.agentId}>
              <SidebarMenuSubButton asChild>
                <button
                  type="button"
                  onClick={() => onOpenAgent(member.agentId)}
                  title={translateText("chat:groups.members.talkAlone", {
                    name: nameOf(member.agentId),
                  })}
                >
                  <AgentAvatar
                    agent={{ id: member.agentId }}
                    className="size-3.5"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {nameOf(member.agentId)}
                  </span>
                  {busyMember(member) ? (
                    <span className="shrink-0 font-mono text-[10px] text-state-success">
                      ●
                    </span>
                  ) : null}
                </button>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      ) : null}
    </SidebarMenuItem>
  );
}

/**
 * Renaming in place: the title becomes a field, Enter or losing focus commits, Escape gives up.
 *
 * In place because a dialog for three words is a dialog you stop using; losing focus commits
 * because that is what "clicked away" means when the thing you were editing is a name.
 */
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
  const cancelled = useRef(false);
  return (
    <Input
      autoFocus
      value={value}
      maxLength={100}
      onChange={(event) => onChange(event.target.value)}
      onBlur={() => {
        if (cancelled.current) return;
        onCommit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelled.current = true;
          onCancel();
        }
      }}
      className="h-6 min-w-0 flex-1 px-1 py-0 text-sm"
    />
  );
}

/**
 * The row's `⋯`: rename, archive (or bring back). The host has no way to delete a conversation,
 * so the menu has none either.
 */
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
          className="top-2"
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

/**
 * Who is in this conversation, as a stack.
 *
 * Three avatars and a count: enough to recognise the room at a glance, and `+2` is the honest way
 * to say there are more rather than a fourth face that is not really the fourth. A one-member
 * conversation gets its single avatar, which is the same thing with nothing to overlap.
 */
function MemberStack({ members }: { members: readonly MemberView[] }) {
  const shown = members.slice(0, 3);
  const rest = members.length - shown.length;
  if (members.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center" aria-hidden="true">
      {/* No box behind them: a blob avatar is a filled shape with transparent surroundings, so a
       * wrapper is a dark frame in a dark theme — the frame is the bug, not the overlap. */}
      <span className="flex -space-x-1.5">
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
