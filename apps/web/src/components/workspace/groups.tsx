import type {
  AgentStatus as AgentStatusName,
  ConversationSummary,
  MemberStatus,
} from "@eta/client-contracts";
import type { ProjectChoice } from "./use-project-choice";
import { AppWindowIcon } from "@phosphor-icons/react/AppWindow";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Empty, Loading } from "@/components/states";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { agentName } from "@/queries/agents";
import { useArtifacts } from "@/queries/artifacts";
import {
  useConversation,
  useConversationActions,
} from "@/queries/conversations";
import { useLinkTask, useTasks } from "@/queries/tasks";
import { wireErrorMessage } from "@/queries/wire";
import { ActivityRefCard } from "./activity-ref";
import { AgentAvatar, AgentStatus, AgentStatusDot } from "./agent-identity";
import { agentStatusLabels, memberStatusLabel } from "./agent-status";
import { InspectButton } from "./inspect-button";
import { MemberRing } from "./member-ring";
import { MemberStats } from "./member-stats";
import { MemberTasksButton, MemberTasksPanel } from "./member-tasks";
import { ProjectField } from "./project-field";
import { useReturnFocus } from "./return-focus";
import { when } from "./routine-format";
import { useAgents, useOpenAgent } from "./use-agents";
import { useChatList } from "./use-chat-list";
import { useGroups, useOpenGroup } from "./use-groups";
import { useChosenProject, useResolveProject } from "./use-project-choice";
import { useWorkspaceStore } from "./workspace-store";

const onError = (error: Error) => toast.error(wireErrorMessage(error));

/** What a member is doing, in the vocabulary of an agent's status. */
function memberStatus(status: MemberStatus): AgentStatusName {
  return status === "idle" || status === "waiting_for_input"
    ? status
    : "working";
}

function GroupAvatars({
  group,
  className,
}: {
  group: ConversationSummary;
  className?: string;
}) {
  return (
    <span
      className={cn("flex shrink-0 -space-x-2", className)}
      aria-hidden="true"
    >
      {group.participants.slice(0, 3).map((p) => (
        <AgentAvatar
          key={p.agentId}
          agent={{ id: p.agentId }}
          className="size-6"
        />
      ))}
    </span>
  );
}

/**
 * The 新建群 dialog, opened by its own trigger (children, or a plus), or
 * by its owner through open and onOpenChange.
 */
export function CreateGroup({
  members = [],
  children,
  open: controlled,
  onOpenChange,
}: {
  members?: string[];
  children?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t: translateText } = useTranslation([
    "chat",
    "agents",
    "artifacts",
    "common",
    "settings",
  ] as const);
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlled ?? uncontrolled;
  const setOpen = onOpenChange ?? setUncontrolled;
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  // Where the group works: a project, or a typed path to add as one (a folder picker is the
  // desktop's job, and a typed path is honest about what will be used).
  const [choice, setChoice] = useState<ProjectChoice>({
    projectId: undefined,
    path: "",
  });
  const { project, adding } = useChosenProject(choice);
  const resolver = useResolveProject();
  const [chosen, setChosen] = useState<string[]>(members);
  const { agents } = useAgents();
  const { create, update } = useConversationActions();
  const openGroup = useOpenGroup();
  const returnFocus = useReturnFocus(open);
  // isPending only updates on the next render; a double click on 创建群
  // must not create the group twice.
  const sendingRef = useRef(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) setChosen(members);
      }}
    >
      {controlled === undefined && (
        <DialogTrigger asChild>
          {children ?? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={translateText("groups.actions.create")}
            >
              <PlusIcon />
            </Button>
          )}
        </DialogTrigger>
      )}
      <DialogContent onCloseAutoFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>{translateText("groups.actions.create")}</DialogTitle>
          <DialogDescription>
            {translateText("groups.createDescription")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (sendingRef.current) return;
            sendingRef.current = true;
            void (async () => {
              try {
                const target = await resolver.resolve(
                  choice,
                  project,
                  chosen[0] ?? null,
                );
                const { conversation } = await create.mutateAsync({
                  projectId: target.id,
                  name: name.trim(),
                  agentIds: chosen,
                });
                if (goal.trim())
                  await update.mutateAsync({
                    conversationId: conversation.id,
                    goal,
                  });
                setOpen(false);
                setName("");
                setGoal("");
                setChoice({ projectId: undefined, path: "" });
                openGroup(conversation.id);
              } catch (error) {
                onError(error as Error);
              } finally {
                sendingRef.current = false;
              }
            })();
          }}
        >
          <label className="grid gap-2 text-sm">
            {translateText("groups.fields.name")}
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={translateText("groups.fields.namePlaceholder")}
              maxLength={100}
            />
          </label>
          <ProjectField choice={choice} onChange={setChoice} />
          <label className="grid gap-2 text-sm">
            {translateText("groups.fields.optionalGoal")}
            <Textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              maxLength={10000}
            />
          </label>
          <fieldset className="grid max-h-64 gap-1 overflow-y-auto">
            <legend className="mb-2 text-sm">
              {translateText("groups.members.title")}
            </legend>
            {agents.map((a) => (
              <label
                key={a.id}
                className="flex min-h-10 items-center gap-2 text-sm"
              >
                <Checkbox
                  checked={chosen.includes(a.id)}
                  onCheckedChange={(v) =>
                    setChosen(
                      v
                        ? [...chosen, a.id]
                        : chosen.filter((id) => id !== a.id),
                    )
                  }
                />
                <AgentAvatar agent={a} className="size-6" />
                {a.name}
              </label>
            ))}
          </fieldset>
          <DialogFooter>
            <Button
              type="submit"
              disabled={
                !chosen.length ||
                create.isPending ||
                (adding && choice.path.trim().length === 0)
              }
            >
              {translateText("groups.actions.createGroup")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The line under a name.
 *
 * It is the row's content slot, not its type slot. A direct chat and a group are already told
 * apart by their avatars — one face, or a stack — so 「私聊」 and 「无消息」 were words that carried
 * nothing: the first restated the row's shape, the second restated its emptiness. What is left to
 * say is what actually differs between two rows at a glance: whether that agent is busy, what was
 * last said, and — for a group that has said nothing yet — how many are in it.
 *
 * A busy agent wins over the preview: it is the one fact on the row that changes on its own while
 * the list sits still, and the preview of a conversation someone is working in is stale by design.
 */
function conversationLine(conversation: ConversationSummary): string | null {
  if (conversation.kind === "direct") {
    const status = conversation.participants[0]?.status;
    if (status !== undefined && status !== "idle") {
      return memberStatusLabel(status);
    }
    return conversation.preview || null;
  }
  return (
    conversation.preview ||
    translate("chat:groups.members.count", {
      count: conversation.participants.length,
    })
  );
}

/** The phone's home: the one list of everything you can chat with, newest activity first. */
export function GroupList() {
  const { t: translateText } = useTranslation([
    "chat",
    "agents",
    "artifacts",
    "common",
    "settings",
  ] as const);
  const { directories, directs, loaded } = useChatList();
  // The phone keeps one list — there is no room for two headings on a screen you scroll with a
  // thumb — so the two sections are flattened back into one, newest activity first.
  const rows = [
    ...[
      ...directories.flatMap((directory) => directory.conversations),
      ...directs.flatMap((entry) =>
        entry.conversation === undefined ? [] : [entry.conversation],
      ),
    ]
      .sort(
        (left, right) =>
          (right.lastMessageAt ?? right.updatedAt) -
          (left.lastMessageAt ?? left.updatedAt),
      )
      .map((conversation) => ({
        kind: "conversation" as const,
        conversation,
      })),
    ...directs
      .filter((entry) => entry.conversation === undefined)
      .map((entry) => ({ kind: "agent" as const, agent: entry.agent })),
  ];
  const open = useOpenGroup();
  const openAgent = useOpenAgent();
  const rowClass =
    "flex w-full min-h-18 items-center gap-2 px-2 py-3 text-left outline-none transition-colors hover:bg-sidebar-accent active:bg-sidebar-accent focus-visible:ring-1 focus-visible:ring-ring";
  return (
    // No band of its own at the top of the list. The page's own header already says what this
    // screen is, and a second title under it spent a hundred pixels of a phone saying it twice —
    // the room is better spent on a row. Its rows carry their own padding, so the list can start
    // straight under the header.
    <section className="min-h-0 flex-1 overflow-y-auto px-3">
      <ul className="space-y-px">
        {rows.map((row) =>
          row.kind === "agent" ? (
            <li key={row.agent.id}>
              <button
                type="button"
                onClick={() => openAgent(row.agent.id)}
                title={translateText("agents:actions.chatWith", {
                  name: row.agent.name,
                })}
                className={rowClass}
              >
                <AgentAvatar agent={row.agent} className="size-6" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    {row.agent.name}
                  </span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {agentStatusLabels[row.agent.status]}
                  </span>
                </span>
                <AgentStatusDot status={row.agent.status} />
              </button>
            </li>
          ) : (
            <li key={row.conversation.id}>
              <button
                type="button"
                onClick={() => open(row.conversation.id)}
                title={row.conversation.name}
                className={rowClass}
              >
                <GroupAvatars group={row.conversation} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-sm">
                      {row.conversation.name}
                    </span>
                    {row.conversation.lastMessageAt !== null && (
                      <time
                        dateTime={new Date(
                          row.conversation.lastMessageAt,
                        ).toISOString()}
                        className="shrink-0 text-xs text-muted-foreground tabular-nums"
                      >
                        {when(row.conversation.lastMessageAt).replace(
                          `${translateText("common:time.today")} `,
                          "",
                        )}
                      </time>
                    )}
                  </span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {conversationLine(row.conversation)}
                  </span>
                </span>
                {row.conversation.unread > 0 && (
                  <span className="shrink-0 text-xs tabular-nums">
                    {row.conversation.unread}
                  </span>
                )}
              </button>
            </li>
          ),
        )}
      </ul>
      {loaded && !rows.length && (
        <p className="px-2 py-6 text-xs text-muted-foreground">
          {translateText("history.noConversations")}
        </p>
      )}
    </section>
  );
}

/** Settings' 已归档: archived conversations, to open or bring back. */
export function ArchivedGroups() {
  const { t: translateText } = useTranslation([
    "chat",
    "agents",
    "artifacts",
    "common",
    "settings",
  ] as const);
  const { groups } = useGroups();
  const open = useOpenGroup();
  const { update } = useConversationActions();
  const setSettings = useWorkspaceStore((s) => s.setSettings);
  const archived = groups.filter((g) => g.archived);
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">
        {translateText("groups.archived.title")}
      </h2>
      {archived.length ? (
        <ul className="space-y-px">
          {archived.map((g) => (
            <li key={g.id} className="flex min-h-14 items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setSettings((state) => ({ ...state, open: false }));
                  open(g.id);
                }}
                className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-2 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
              >
                <GroupAvatars group={g} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{g.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[
                      g.lastMessageAt !== null ? when(g.lastMessageAt) : null,
                      conversationLine(g),
                    ]
                      .filter((part) => part !== null && part !== "")
                      .join(" · ")}
                  </span>
                </span>
              </button>
              <Button
                size="xs"
                variant="outline"
                disabled={update.isPending}
                onClick={() =>
                  update.mutate(
                    { conversationId: g.id, archived: false },
                    { onError },
                  )
                }
              >
                {translateText("groups.actions.unarchive")}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          {translateText("groups.archived.empty")}
        </p>
      )}
    </div>
  );
}

/** A group chat's 成员 tab: who is in it, and the group's own actions. */
export function GroupMembers() {
  const { t: translateText } = useTranslation([
    "chat",
    "agents",
    "artifacts",
    "common",
    "settings",
  ] as const);
  const { current: group } = useGroups();
  // The conversation's own facts (goal, decisions) live on its target, not in the list.
  const { info } = useConversation(group?.id);
  const { agents, openEditor } = useAgents();
  const { update, invite: invite_, remove } = useConversationActions();
  const [edit, setEdit] = useState(false);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [decided, setDecided] = useState("");
  const { tasks: board } = useTasks();
  const linkTaskCall = useLinkTask();
  const [linkTask, setLinkTask] = useState(false);
  const [invite, setInvite] = useState(false);
  const [removing, setRemoving] = useState<string>();
  /** Whose tasks are open under its card: one at a time, and the same press closes it. */
  const [tasksFor, setTasksFor] = useState<string | null>(null);
  const focused = useWorkspaceStore((state) => state.focusedAgentId);
  const setFocusedAgent = useWorkspaceStore((state) => state.setFocusedAgent);
  if (!group) return null;
  const members = group.participants;
  const linked = board.filter((t) => t.conversationId === group.id);
  return (
    <section aria-label={translateText("groups.members.title")}>
      <div className="mb-2 flex items-center gap-1">
        <h3 className="flex-1 text-xs text-muted-foreground tabular-nums">
          {translateText("groups.members.count", {
            count: members.length,
          })}
        </h3>
        {!group.archived && (
          <Button size="xs" variant="ghost" onClick={() => setInvite(true)}>
            {translateText("groups.actions.invite")}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={translateText("groups.accessibility.actions")}
            >
              <DotsThreeIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => {
                setName(group.name);
                setGoal(info?.goal ?? "");
                setDecided(info?.decided ?? "");
                setEdit(true);
              }}
            >
              {translateText("groups.actions.editInfo")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setLinkTask(true)}>
              {translateText("groups.relatedTasks.title")}
              {linked.length ? (
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {linked.length}
                </span>
              ) : null}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                update.mutate(
                  { conversationId: group.id, archived: !group.archived },
                  { onError },
                )
              }
            >
              {group.archived
                ? translateText("groups.actions.unarchive")
                : translateText("groups.actions.archive")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {/* One member per row: a member carries three lines (name, status, its session's numbers),
          and auto-fill columns turn that into two cramped columns in a 320px panel. */}
      <ul className="grid grid-cols-1 gap-1">
        {members.map((p) => {
          const agent = agents.find((a) => a.id === p.agentId);
          const name = agentName(agents, p.agentId);
          const removable = group.kind === "group" && members.length > 1;
          return (
            <li
              key={p.agentId}
              className={cn(
                "min-w-0 border",
                // Focused is a frame around the card, not a different card: the numbers stay where
                // they were, so comparing two members does not mean re-learning the layout.
                focused === p.agentId ? "border-foreground" : "border-border",
              )}
            >
              <div className="flex min-w-0 items-start gap-2 px-2 py-1.5">
                {/* The row's first thing was the member's avatar; the gauge wraps that one instead
                  of adding a second avatar beside the numbers. A member with no session yet has
                  nothing to draw a ring around, so it is just the avatar. */}
                {p.sessionId === null ? (
                  <AgentAvatar agent={{ id: p.agentId }} />
                ) : (
                  <MemberRing sessionId={p.sessionId}>
                    <AgentAvatar agent={{ id: p.agentId }} />
                  </MemberRing>
                )}
                {/* Pressing the member is the same action as pressing its card anywhere else: the
                  chat narrows to it. The menu beside it is the other thing a member has. */}
                <button
                  type="button"
                  // Press to focus, press again to let go. The frame is the whole state: white
                  // border = narrowed to this member, and the same press takes it back.
                  onClick={() =>
                    setFocusedAgent(focused === p.agentId ? null : p.agentId)
                  }
                  title={translateText("groups.members.focus", { name })}
                  className="min-w-0 flex-1 text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <span className="block truncate" title={name}>
                    {name}{" "}
                    <span className="text-xs text-muted-foreground">
                      {agent ? (
                        <AgentStatus status={memberStatus(p.status)} />
                      ) : (
                        translateText("common:status.deleted")
                      )}
                    </span>
                  </span>
                  {/* What this member has spent, is producing, and is chasing. */}
                  <MemberStats sessionId={p.sessionId ?? undefined} />
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  {p.sessionId === null ? null : (
                    <MemberTasksButton
                      sessionId={p.sessionId}
                      open={tasksFor === p.sessionId}
                      onToggle={() =>
                        setTasksFor(
                          tasksFor === p.sessionId ? null : p.sessionId,
                        )
                      }
                    />
                  )}
                  {p.sessionId === null ? null : (
                    <InspectButton sessionId={p.sessionId} name={name} />
                  )}
                  {(agent || removable) && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={translateText(
                            "common:accessibility.itemActions",
                            {
                              name,
                            },
                          )}
                        >
                          <DotsThreeIcon aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {agent && (
                          <DropdownMenuItem
                            onSelect={() => openEditor(agent.id)}
                          >
                            {translateText("settings:title")}
                          </DropdownMenuItem>
                        )}
                        {removable && (
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setRemoving(p.agentId)}
                          >
                            {translateText("common:actions.remove")}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
              {p.sessionId !== null && tasksFor === p.sessionId ? (
                <MemberTasksPanel sessionId={p.sessionId} />
              ) : null}
            </li>
          );
        })}
      </ul>
      <AlertDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="wrap-anywhere">
              {translateText("groups.members.removeConfirmTitle", {
                name: removing === undefined ? "" : agentName(agents, removing),
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {translateText("groups.members.removeConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {translateText("common:actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={() =>
                removing &&
                remove.mutate(
                  { conversationId: group.id, agentId: removing },
                  { onError },
                )
              }
            >
              {translateText("common:actions.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={linkTask} onOpenChange={setLinkTask}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {translateText("groups.relatedTasks.title")}
            </DialogTitle>
            <DialogDescription>
              {translateText("groups.relatedTasks.help")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid max-h-96 gap-2 overflow-y-auto">
            {linked.map((t) => (
              <div key={t.id} className="flex min-w-0 items-center gap-1">
                <ActivityRefCard
                  className="min-w-0 flex-1"
                  value={{
                    kind: "task",
                    id: t.id,
                    number: t.number,
                    title: t.title,
                    status: t.status,
                  }}
                />
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={linkTaskCall.isPending}
                  onClick={() =>
                    linkTaskCall.mutate(
                      { taskId: t.id, conversationId: null },
                      { onError },
                    )
                  }
                >
                  {translateText("groups.relatedTasks.unlink")}
                </Button>
              </div>
            ))}
            {board
              .filter((t) => t.conversationId !== group.id)
              .map((t) => (
                <Button
                  key={t.id}
                  variant="ghost"
                  className="justify-start truncate"
                  disabled={linkTaskCall.isPending || group.archived}
                  aria-label={translateText("groups.relatedTasks.linkLabel", {
                    number: t.number,
                    title: t.title,
                  })}
                  onClick={() =>
                    linkTaskCall.mutate(
                      { taskId: t.id, conversationId: group.id },
                      { onError },
                    )
                  }
                >
                  <PlusIcon aria-hidden="true" />#{t.number} {t.title}
                </Button>
              ))}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={edit} onOpenChange={setEdit}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {translateText("groups.actions.editInfo")}
            </DialogTitle>
            <DialogDescription>
              {translateText("groups.fields.goalHelp")}
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate(
                {
                  conversationId: group.id,
                  name: group.kind === "group" ? name : undefined,
                  goal,
                  decided,
                },
                { onError, onSuccess: () => setEdit(false) },
              );
            }}
          >
            {group.kind === "group" && (
              <label className="grid gap-2 text-sm">
                {translateText("groups.fields.name")}
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={100}
                  required
                />
              </label>
            )}
            <label className="grid gap-2 text-sm">
              {translateText("groups.fields.goal")}
              <Textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                maxLength={10000}
              />
            </label>
            <label className="grid gap-2 text-sm">
              {translateText("groups.fields.decisions")}
              <Textarea
                value={decided}
                onChange={(e) => setDecided(e.target.value)}
                maxLength={10000}
              />
            </label>
            <DialogFooter>
              <Button disabled={update.isPending}>
                {translateText("common:actions.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={invite} onOpenChange={setInvite}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {translateText("groups.members.inviteTitle")}
            </DialogTitle>
            <DialogDescription>
              {translateText("groups.members.inviteDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid max-h-80 gap-1 overflow-y-auto">
            {agents
              .filter((a) => !members.some((p) => p.agentId === a.id))
              .map((a) => (
                <Button
                  key={a.id}
                  variant="ghost"
                  className="justify-start"
                  disabled={invite_.isPending}
                  onClick={() =>
                    invite_.mutate(
                      { conversationId: group.id, agentId: a.id },
                      { onError, onSuccess: () => setInvite(false) },
                    )
                  }
                >
                  <AgentAvatar agent={a} className="size-6" />
                  {a.name}
                </Button>
              ))}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** A group chat's Artifacts tab: what its agents published in it. */
export function GroupArtifacts() {
  const { t: translateText } = useTranslation([
    "chat",
    "agents",
    "artifacts",
    "common",
    "settings",
  ] as const);
  const { current: group } = useGroups();
  const { artifacts: all, loaded } = useArtifacts();
  if (!group) return null;
  const artifacts = all.filter((a) => a.conversationId === group.id);
  if (!loaded) return <Loading rows={2} />;
  if (!artifacts.length)
    return (
      <Empty
        icon={AppWindowIcon}
        title={translateText("artifacts:empty.title")}
      >
        {translateText("artifacts:empty.description")}
      </Empty>
    );
  return (
    <ul aria-label="Artifacts" className="space-y-2">
      {artifacts.map((a) => (
        <li key={a.id}>
          <ActivityRefCard
            value={{
              kind: "artifact",
              id: a.id,
              title: a.title,
              number: a.versions[0]?.number,
            }}
          />
        </li>
      ))}
    </ul>
  );
}
