import type {
  AgentView,
  ConversationSummary,
  MemberView,
} from "@eta/client-contracts";
import type { ReactNode } from "react";
import type { DirectoryGroup } from "./use-chat-list";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { ChatsCircleIcon } from "@phosphor-icons/react/ChatsCircle";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loading } from "@/components/states";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { agentName, useAgentList } from "@/queries/agents";
import { useArtifacts } from "@/queries/artifacts";
import { useCaptain } from "@/queries/captain";
import { useConversationActions } from "@/queries/conversations";
import { useModels } from "@/queries/providers";
import { useTasks } from "@/queries/tasks";
import { AgentAvatar, AgentStatusDot } from "./agent-identity";
import { agentStatusLabels, memberStatusLabel } from "./agent-status";
import { MemberRing } from "./member-ring";
import { MemberStats } from "./member-stats";
import { useOpenAgent } from "./use-agents";
import { useChatList } from "./use-chat-list";
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

/**
 * Captain, at the head of the sidebar and outside the list that scrolls.
 *
 * It is one agent in one conversation, so what is worth showing is what that conversation is made
 * of — and that is exactly what Member draws: the ring around the avatar (`MemberRing`) and the
 * session's own numbers under it (`MemberStats`). Both are the group panel's components, reused
 * rather than re-read: a second way of counting a session's spend is a second thing to keep true.
 *
 * The avatar is this section's size, not a row's. It is the one thing in the sidebar that is a
 * thing rather than an entry, and it should hold the eye before the list does.
 */
export function CaptainSection({ rail }: { rail: boolean }) {
  const { t: translateText } = useTranslation([
    "navigation",
    "tasks",
    "artifacts",
    "captain",
  ] as const);
  const captain = useCaptain();
  // What Captain is holding for a person: an approval not yet decided, an alert not yet read.
  // The same count the Operations blocks in its context panel open with.
  const waiting =
    captain.operations.filter((item) => item.status === "pending").length +
    captain.notifications.filter((item) => item.readAt === null).length;
  const { groups } = useGroups();
  const open = useOpenGroup();
  const { tasks: board } = useTasks();
  const { artifacts } = useArtifacts();

  // The host makes Captain whole when it starts, conversation included (`CaptainService.ensure`),
  // so a Captain without one is only the moment before the first state arrives.
  const conversationId = captain.identity?.conversationId ?? null;
  if (captain.identity === null || conversationId === null) return null;
  // The conversation's own member row: its session is what the ring and the numbers read from.
  const member = groups.find((each) => each.id === conversationId)
    ?.participants[0];
  const sessionId = member?.sessionId ?? undefined;
  const captainTasks = board.filter(
    (task) =>
      task.conversationId === conversationId &&
      task.status !== "done" &&
      task.status !== "cancelled",
  );
  const captainArtifacts = artifacts.filter(
    (art) => art.conversationId === conversationId,
  );
  const name = captain.identity.name;
  // What the card no longer draws, since it is one row: the counts live in the tooltip. Still the
  // same numbers, still off the same query — just not a third and fourth line.
  const counts = [
    captainTasks.length === 0
      ? null
      : `${captainTasks.length} ${translateText("navigation:sections.tasks")}`,
    captainArtifacts.length === 0
      ? null
      : `${captainArtifacts.length} ${translateText("navigation:sections.artifacts")}`,
  ]
    .filter((each) => each !== null)
    .join(" · ");
  const face = (size: string) => (
    <AgentAvatar
      agent={{ id: captain.identity === null ? "" : captain.identity.agentId }}
      animate
      className={size}
    />
  );

  // The rail is 4rem: the glyph and the name under it, as every other card there.
  if (rail) {
    return (
      <SidebarGroup
        data-section="captain"
        aria-label={name}
        className="shrink-0 border-b px-0 pt-2 pb-2"
      >
        <button
          type="button"
          onClick={() => open(conversationId)}
          aria-label={
            waiting === 0
              ? name
              : `${name} · ${translateText("captain:operationsBadge", { count: waiting })}`
          }
          title={name}
          className="relative mx-auto flex cursor-pointer items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {sessionId === undefined ? (
            face("size-10")
          ) : (
            <MemberRing sessionId={sessionId} size={48}>
              {face("size-10")}
            </MemberRing>
          )}
          {/* Folded to a rail there is no room for two words, so the badge becomes its number. */}
          {waiting === 0 ? null : (
            <span
              data-captain-waiting={waiting}
              aria-hidden="true"
              className="absolute top-0 right-0 rounded-full bg-muted px-1 font-mono text-[10px] tabular-nums text-muted-foreground"
            >
              {waiting}
            </span>
          )}
        </button>
      </SidebarGroup>
    );
  }

  return (
    <SidebarGroup
      data-section="captain"
      aria-label={name}
      className="shrink-0 px-0 pb-2"
    >
      {/* No label above the card: the card says what it is. A heading that repeats the name the
          card already shows is one more line between the window's top edge and the list.
          The card is one row, top to bottom: face, name, state, and the session's numbers all on
          the same baseline. A block of stats under the name made this the tallest thing in the
          sidebar, which is the one thing a section head must not be. */}
      <div className="mx-2 mt-2 border">
        <button
          type="button"
          onClick={() => open(conversationId)}
          title={counts === "" ? undefined : counts}
          className="flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {sessionId === undefined ? (
            face("size-10")
          ) : (
            // 48px ring around a 40px face. Half the size it first shipped at: big enough that the
            // gauge reads as a gauge, small enough that it stays a section head and not a poster.
            <MemberRing sessionId={sessionId} size={48}>
              {face("size-10")}
            </MemberRing>
          )}
          <span className="shrink-0 truncate text-sm font-medium">{name}</span>
          {member === undefined ? null : (
            <span className="shrink-0 text-xs text-muted-foreground">
              {memberStatusLabel(member.status)}
            </span>
          )}
          {/* What Captain is holding for a person — an approval, an unread alert — as one chip.
              It is the same count the Operations blocks in its context panel open with, computed on the
              client from data the panel already reads: a card says whether to look, the panel
              says at what. Nothing here asks the host for anything. */}
          {waiting === 0 ? null : (
            <span
              data-captain-waiting={waiting}
              className="shrink-0 rounded-sm bg-muted px-1 font-mono text-[10px] tabular-nums text-muted-foreground"
            >
              {translateText("captain:operationsBadge", { count: waiting })}
            </span>
          )}
          {/* The numbers end the same line rather than starting a new block: what is left of the
              row is theirs, and it truncates from the tail, so a narrow sidebar costs a few digits
              and never the name of the agent the card is about. */}
          <MemberStats
            sessionId={sessionId}
            inline
            className="ml-auto min-w-0 justify-end"
          />
        </button>
      </div>
    </SidebarGroup>
  );
}

export function ConversationList() {
  const { t: translateText } = useTranslation(["chat"] as const);
  const { directories, directs, current, loaded } = useChatList();
  const setNewConversation = useWorkspaceStore(
    (state) => state.setNewConversation,
  );
  const setAgentEditor = useWorkspaceStore((state) => state.setAgentEditor);
  const collapsed = useWorkspaceStore(
    (state) => state.workspace.agentsCollapsed === true,
  );
  const setWorkspace = useWorkspaceStore((state) => state.setWorkspace);
  const open = useOpenGroup();
  const { state, isMobile } = useSidebar();
  // The sidebar's own fold, not the agent shelf's: on the rail every card is a glyph with its
  // name under it, and both halves of the list keep the same shape.
  const rail = state === "collapsed" && !isMobile;

  return (
    <>
      <SidebarGroup
        aria-labelledby="sidebar-groups"
        className="min-h-0 flex-1 overflow-y-auto px-0 pb-0"
      >
        <div
          className={cn(
            "flex items-center border-b pb-1",
            rail ? "justify-center" : "justify-between pr-3 pl-4",
          )}
        >
          <span
            id="sidebar-groups"
            className={cn(
              "font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase [&:lang(zh)]:tracking-normal",
              // Still the section's name, just not drawn: a heading cannot fit in a rail.
              rail && "sr-only",
            )}
          >
            {translateText("chat:sections.groups")}
          </span>
          <button
            type="button"
            aria-label={translateText("chat:new.title")}
            title={translateText("chat:new.title")}
            onClick={() => setNewConversation({ open: true })}
            className="flex size-6 items-center justify-center text-muted-foreground hover:text-foreground"
          >
            <PlusIcon aria-hidden="true" className="size-3.5" />
          </button>
        </div>
        <SidebarMenu className="divide-y divide-border">
          {directories.length === 0 ? (
            loaded ? (
              <SidebarMenuItem className="px-2 py-1.5">
                <p
                  className={
                    rail ? "sr-only" : "px-2 py-1 text-xs text-muted-foreground"
                  }
                >
                  {translateText("chat:groups.empty.title")}
                </p>
              </SidebarMenuItem>
            ) : (
              // Until `hello`: the rows' outline, so the list does not pop in and push the shelf.
              <SidebarMenuItem className="px-2 pb-1.5">
                <Loading
                  layout={rail ? "glyphs" : "list"}
                  rows={4}
                  rowClassName="h-[3.1rem]"
                />
              </SidebarMenuItem>
            )
          ) : (
            directories.flatMap((directory) =>
              directory.conversations.map((conversation) => (
                <GroupCard
                  key={conversation.id}
                  conversation={conversation}
                  place={directory.place}
                  active={current?.id === conversation.id}
                  onOpen={() => open(conversation.id)}
                  rail={rail}
                />
              )),
            )
          )}
        </SidebarMenu>
      </SidebarGroup>
      <SidebarGroup
        aria-labelledby="sidebar-agents"
        className="mt-auto shrink-0 border-t px-0 pb-0"
      >
        <div
          className={cn(
            "flex items-center border-b pb-1",
            rail ? "justify-center gap-1" : "justify-between pr-3 pl-3",
          )}
        >
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={() =>
              setWorkspace((state) => ({
                ...state,
                agentsCollapsed: !collapsed,
              }))
            }
            className={cn(
              "flex min-w-0 items-center gap-1.5 py-0.5 text-left",
              rail ? "pl-0" : "flex-1 pl-1",
            )}
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
              className={cn(
                "min-w-0 flex-1 truncate font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase [&:lang(zh)]:tracking-normal",
                rail && "sr-only",
              )}
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
            className="flex size-6 items-center justify-center text-muted-foreground hover:text-foreground"
          >
            <PlusIcon aria-hidden="true" className="size-3.5" />
          </button>
        </div>
        {collapsed ? null : (
          // Never more than two fifths of the screen: the agents are who you can talk to, the
          // groups are the work, and the work keeps the room. No horizontal padding, on the rail
          // either: the rules between the rows run to the column's edges, and a card's corner count
          // sits inside its row rather than overhanging the scroll box.
          <div className="max-h-[40dvh] overflow-y-auto">
            <SidebarMenu className="divide-y divide-border">
              {directs.length === 0 ? (
                loaded ? (
                  <SidebarMenuItem className="px-2 py-1.5">
                    <p
                      className={
                        rail
                          ? "sr-only"
                          : "px-2 py-1 text-xs text-muted-foreground"
                      }
                    >
                      {translateText("chat:sections.noAgents")}
                    </p>
                  </SidebarMenuItem>
                ) : (
                  <SidebarMenuItem className="px-2 py-1.5">
                    <Loading layout={rail ? "glyphs" : "list"} rows={2} />
                  </SidebarMenuItem>
                )
              ) : (
                directs.map((entry) => (
                  <AgentCard
                    key={entry.agent.id}
                    agent={entry.agent}
                    unread={entry.conversation?.unread ?? 0}
                    rail={rail}
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
 * The directory line is the reason a group is not interchangeable with any other: two groups can
 * have the same name and work in different places.
 */
function GroupCard({
  conversation,
  place,
  active,
  onOpen,
  rail,
}: {
  conversation: ConversationSummary;
  place: DirectoryGroup["place"];
  active: boolean;
  onOpen: () => void;
  rail: boolean;
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
  const menu = {
    onRename: () => setDraft(conversation.name),
    archived: conversation.archived,
    onArchive: () =>
      update.mutate(
        {
          conversationId: conversation.id,
          archived: !conversation.archived,
        },
        { onError },
      ),
  };

  // On the rail a group is a glyph with its name under it: the member stack says who is in it,
  // the name says which one it is. Everything the wide card writes out has nowhere to go here, so
  // the card keeps the two things a rail can carry and drops the rest rather than clipping it.
  if (rail)
    return (
      <SidebarMenuItem
        className={cn(
          "group/menu-item relative transition-colors duration-75 select-none",
          "hover:bg-sidebar-accent has-data-[state=open]:bg-sidebar-accent",
          active && "bg-sidebar-accent",
        )}
        data-active={active}
      >
        {draft === null ? (
          <RowMenu {...menu}>
            <button
              type="button"
              data-sidebar="menu-button"
              data-active={active}
              aria-current={active ? "true" : undefined}
              title={conversation.name}
              onClick={onOpen}
              className="relative flex w-full flex-col items-center gap-1 px-1 py-1.5 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-hidden"
            >
              {members.length === 0 ? (
                <ChatsCircleIcon
                  aria-hidden="true"
                  className="size-5 text-muted-foreground"
                />
              ) : (
                <MemberStack members={members} compact />
              )}
              <span
                data-slot="conversation-name"
                className="w-full truncate text-center text-[10px] leading-tight"
              >
                {conversation.name}
              </span>
              {busy.length > 0 ? (
                <span className="sr-only">{` ${memberStatusLabel("working")}`}</span>
              ) : null}
              {busy.length > 0 ? (
                <span
                  aria-hidden="true"
                  className="absolute top-0.5 left-0.5 font-mono text-[10px] text-state-success"
                  title={busy
                    .map((member) => nameOf(member.agentId))
                    .join("、")}
                >
                  ●
                </span>
              ) : null}
              {conversation.unread > 0 ? (
                <span
                  data-slot="conversation-unread"
                  className="pointer-events-none absolute top-1 right-1 border border-border bg-sidebar px-0.5 font-mono text-[9px] leading-3 tabular-nums"
                >
                  {conversation.unread}
                </span>
              ) : null}
            </button>
          </RowMenu>
        ) : (
          <div className="px-1 py-1.5">
            <RenameField
              value={draft}
              onChange={setDraft}
              onCommit={commitRename}
              onCancel={() => setDraft(null)}
            />
          </div>
        )}
      </SidebarMenuItem>
    );

  return (
    <SidebarMenuItem
      className={cn(
        "group/menu-item relative transition-colors duration-75 select-none",
        "hover:bg-sidebar-accent has-data-[state=open]:bg-sidebar-accent",
        active && "bg-sidebar-accent",
      )}
      data-active={active}
    >
      {draft === null ? (
        <>
          {/* The card's own click target, under everything: it spans the card, so a right-click
           * anywhere on it lands here. */}
          <RowMenu {...menu}>
            <button
              type="button"
              data-sidebar="menu-button"
              data-active={active}
              aria-current={active ? "true" : undefined}
              title={conversation.name}
              onClick={onOpen}
              className="absolute inset-0 focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-hidden"
            >
              <span className="sr-only">
                {conversation.name}
                {conversation.unread > 0
                  ? ` ${translateText("chat:groups.unreadCount", { count: conversation.unread })}`
                  : null}
                {busy.length > 0 ? ` ${memberStatusLabel("working")}` : null}
              </span>
            </button>
          </RowMenu>
          <div className="pointer-events-none relative z-10 px-4 pt-1.5">
            <div className="flex items-center gap-1.5">
              <MemberStack members={members} />
              <span className="min-w-0 flex-1 truncate text-base leading-tight">
                {conversation.name}
              </span>
              {busy.length > 0 ? (
                <span
                  aria-hidden="true"
                  className="shrink-0 font-mono text-[10px] text-state-success"
                  title={busy.map((m) => nameOf(m.agentId)).join("、")}
                >
                  ●
                </span>
              ) : null}
              {conversation.unread > 0 ? (
                <span
                  aria-hidden="true"
                  className="shrink-0 font-mono text-[10px] text-foreground tabular-nums"
                >
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
              data-slot="conversation-path"
              title={place?.full}
              className="truncate pt-0.5 pb-1.5 font-mono text-[10px] text-faint"
            >
              {place?.short ?? translateText("chat:sections.unknownDirectory")}
            </p>
          </div>
        </>
      ) : (
        <div className="relative z-10 px-4 py-2">
          <RenameField
            value={draft}
            onChange={setDraft}
            onCommit={commitRename}
            onCancel={() => setDraft(null)}
          />
        </div>
      )}
    </SidebarMenuItem>
  );
}

/** One agent as a card: its name, and what it is wearing and running. */
function AgentCard({
  agent,
  unread,
  rail,
}: {
  agent: AgentView;
  unread: number;
  rail: boolean;
}) {
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
  // The rail's card: the avatar, its name under it in the smallest type the column has, and the
  // count or the status in the corner. Same button, same destination as the wide card.
  if (rail)
    return (
      <SidebarMenuItem className="relative transition-colors duration-75">
        <button
          type="button"
          data-sidebar="menu-button"
          title={translateText("chat:groups.members.talkAlone", {
            name: agent.name,
          })}
          onClick={() => openAgent(agent.id)}
          className="flex w-full flex-col items-center gap-1 px-1 py-1.5 transition-colors duration-75 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-hidden"
        >
          <AgentAvatar agent={agent} className="size-6" />
          <span
            data-slot="agent-name"
            className="w-full truncate text-center text-[10px] leading-tight"
          >
            {agent.name}
          </span>
          {/* The count is drawn on the item's corner, outside this button, so it has to be written
              here as well for the name to carry it. */}
          {unread > 0 ? <span className="sr-only">{unread}</span> : null}
          <span className="sr-only">{agentStatusLabels[agent.status]}</span>
        </button>
        {unread > 0 ? (
          <span
            data-slot="agent-unread"
            className="pointer-events-none absolute top-1 right-1 border border-border bg-sidebar px-0.5 font-mono text-[9px] leading-3 tabular-nums"
          >
            {unread}
          </span>
        ) : (
          <AgentStatusDot
            status={agent.status}
            className="pointer-events-none absolute top-0.5 right-0.5"
          />
        )}
      </SidebarMenuItem>
    );
  return (
    <SidebarMenuItem className="transition-colors duration-75">
      <button
        type="button"
        data-sidebar="menu-button"
        title={translateText("chat:groups.members.talkAlone", {
          name: agent.name,
        })}
        onClick={() => openAgent(agent.id)}
        className="flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors duration-75 hover:bg-sidebar-accent"
      >
        {/* Top-aligned, not centred: the avatar lines up with the name, so a card with tags
         * underneath still reads as avatar-then-name rather than a block floating mid-row. */}
        <AgentAvatar agent={agent} className="size-6 self-start" />
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

/** The card's member avatars: as many as fit, then a count. On the rail they are all the room there
 * is, so they shrink and the count goes: three faces say more than a number in a 4rem column. */
function MemberStack({
  members,
  compact = false,
}: {
  members: readonly MemberView[];
  compact?: boolean;
}) {
  const shown = members.slice(0, 3);
  const rest = compact ? 0 : members.length - shown.length;
  if (members.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center" aria-hidden="true">
      {/* No box behind them: a blob avatar is a filled shape with transparent surroundings, so a
       * wrapper is a dark frame in a dark theme — the frame is the bug, not the overlap. */}
      <span className={cn("flex", compact ? "-space-x-1.5" : "-space-x-1")}>
        {shown.map((member) => (
          <AgentAvatar
            key={member.agentId}
            agent={{ id: member.agentId }}
            className={compact ? "size-4" : "size-5"}
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

/** What a card can do, on the card itself: right-click, long-press, or the keyboard's menu key. */
function RowMenu({
  children,
  onRename,
  archived,
  onArchive,
}: {
  children: ReactNode;
  onRename: (() => void) | undefined;
  archived: boolean;
  onArchive: () => void;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  // Renaming starts once the menu has finished closing. Radix hands focus back at that moment,
  // and a field that was already up would lose it, which its blur reads as a commit.
  const renamingRef = useRef(false);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(event) => {
          if (!renamingRef.current) return;
          renamingRef.current = false;
          event.preventDefault();
          onRename?.();
        }}
      >
        {onRename === undefined ? null : (
          <ContextMenuItem
            onSelect={() => {
              renamingRef.current = true;
            }}
          >
            {translateText("chat:groups.actions.rename")}
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={onArchive}>
          {archived
            ? translateText("chat:groups.actions.unarchive")
            : translateText("chat:groups.actions.archive")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
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
