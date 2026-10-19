import type { ConversationSummary, MemberView } from "@eta/client-contracts";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { matchesQuery, projectTree } from "@/lib/projects";
import { cn } from "@/lib/utils";
import { agentName, useAgentList } from "@/queries/agents";
import {
  useConversationActions,
  useConversationList,
} from "@/queries/conversations";
import { useMachines, useProjects } from "@/queries/projects";
import { AgentAvatar } from "./agent-identity";
import { useGroups, useOpenGroup } from "./use-groups";
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
 * The sidebar tree: projects, the conversations in them, and who is in each one.
 *
 * Three levels, each one a fact rather than a container: the project is where the work happens
 * (a directory on a machine; with several machines, they head the projects), the conversation is
 * what is being discussed, the member is a person you can talk to alone. Private chats are one
 * section of their own, above the projects: a private chat is a conversation in the agent's own
 * workspace, and its name *is* the agent, so it has no members to expand.
 */

const row =
  "group flex min-h-8 w-full min-w-0 items-center gap-1.5 px-2 text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function ProjectTree({ query = "" }: { query?: string }) {
  const { t: translateText } = useTranslation(["chat", "navigation"] as const);
  const { conversations } = useConversationList();
  const { projects } = useProjects();
  const { machines } = useMachines();
  const { agents } = useAgentList();
  const { current } = useGroups();
  const open = useOpenGroup();
  const navigate = useNavigate();
  const setFocusedAgent = useWorkspaceStore((state) => state.setFocusedAgent);
  const focusedAgentId = useWorkspaceStore((state) => state.focusedAgentId);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const groups = useMemo(
    () =>
      projectTree({
        conversations,
        projects,
        machines,
        searching: query.trim().length > 0,
        matches: (conversation, project) =>
          matchesQuery(
            conversation,
            project,
            conversation.participants.map((m) => agentName(agents, m.agentId)),
            query,
          ),
      }),
    [conversations, projects, machines, agents, query],
  );

  if (groups.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        {query.trim().length > 0
          ? translateText("chat:groups.search.empty")
          : translateText("chat:groups.empty.title")}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-1 pb-2">
      {groups.map((group) => (
        <div key={group.machine?.id ?? "all"} className="grid gap-2">
          {group.machine === undefined ? null : (
            <h2 className="px-2 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
              {group.machine.name}
            </h2>
          )}
          {group.sections.map((section) => (
            <section
              key={section.key}
              aria-label={
                section.direct
                  ? translateText("chat:groups.directChat")
                  : section.label
              }
            >
              {/* The project's own row: its name, and the one action that belongs to a project
                  rather than to a conversation in it — starting another one there. */}
              <div className="flex h-6 items-center gap-1 px-2">
                <h3
                  className="min-w-0 flex-1 truncate font-mono text-[10px] tracking-[0.12em] text-faint uppercase"
                  title={section.path || undefined}
                >
                  {section.direct
                    ? translateText("chat:groups.directChat")
                    : section.label}
                </h3>
                {section.direct ? null : (
                  <button
                    type="button"
                    aria-label={translateText("chat:new.title")}
                    title={translateText("chat:new.title")}
                    onClick={() =>
                      void navigate({
                        to: "/new",
                        search: { project: section.key },
                      })
                    }
                    className="shrink-0 border border-border px-1 text-xs leading-none text-muted-foreground hover:border-border-strong hover:text-foreground"
                  >
                    +
                  </button>
                )}
              </div>
              <ul>
                {section.conversations.map((conversation) => (
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
                    // Press to focus, press again to let go. Opening a separate private chat is
                    // what the agent library is for.
                    onOpenAgent={(agentId) => {
                      setFocusedAgent(
                        focusedAgentId === agentId ? null : agentId,
                      );
                      open(conversation.id);
                    }}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      ))}
    </div>
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
    <li>
      {/*
       * eta-old's session row: the title on top with its age at the right and a `⋯` beside it, the
       * id under it. Two lines because they answer two questions in the order you ask them — what
       * is this, which one is it — and the border appears only for the row you are in. Where it
       * works is the heading above it.
       */}
      <div
        className={cn(
          "group mb-1 border p-2",
          active
            ? "border-border-strong bg-sidebar-accent"
            : "border-transparent hover:bg-sidebar-accent",
        )}
      >
        <div className="flex items-center gap-1">
          {expandable ? (
            <button
              type="button"
              aria-label={
                expanded
                  ? translateText("chat:groups.members.collapse")
                  : translateText("chat:groups.members.expand")
              }
              aria-expanded={expanded}
              onClick={onToggle}
              className="shrink-0 text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <CaretRightIcon
                aria-hidden="true"
                className={cn("size-3", expanded && "rotate-90")}
              />
            </button>
          ) : null}
          <MemberStack members={members} />
          {draft === null ? (
            <button
              type="button"
              onClick={onOpen}
              className="min-w-0 flex-1 truncate text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              title={conversation.name}
            >
              {conversation.name}
            </button>
          ) : (
            <RenameField
              value={draft}
              onChange={setDraft}
              onCommit={commitRename}
              onCancel={() => setDraft(null)}
            />
          )}
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
          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
            {humanizeAge(conversation.lastMessageAt ?? conversation.updatedAt)}
          </span>
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
        </div>
      </div>
      {expandable && expanded ? (
        <ul className="mb-0.5 ml-5 border-l border-border">
          {members.map((member) => (
            <li key={member.agentId}>
              <button
                type="button"
                onClick={() => onOpenAgent(member.agentId)}
                title={translateText("chat:groups.members.talkAlone", {
                  name: nameOf(member.agentId),
                })}
                className={cn(
                  row,
                  "text-muted-foreground hover:text-foreground",
                )}
              >
                <AgentAvatar
                  agent={{ id: member.agentId }}
                  className="size-3.5 shrink-0"
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
            </li>
          ))}
        </ul>
      ) : null}
    </li>
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
        <button
          type="button"
          aria-label={translateText("chat:groups.accessibility.actions")}
          className="shrink-0 border border-transparent px-1 text-xs text-muted-foreground hover:border-border-strong hover:text-foreground"
        >
          ⋯
        </button>
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
