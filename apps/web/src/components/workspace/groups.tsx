import type { Group } from "@/queries/chat";
import { AppWindowIcon } from "@phosphor-icons/react/AppWindow";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { UsersThreeIcon } from "@phosphor-icons/react/UsersThree";
import { useQuery } from "@tanstack/react-query";
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
import { cn } from "@/lib/utils";
import { useArtifacts } from "@/queries/artifacts";
import { chatQueryOptions } from "@/queries/chat";
import { useGroupActions } from "@/queries/groups";
import { useTasks, useUpdateTask } from "@/queries/tasks";
import { ActivityRefCard } from "./activity-ref";
import { AgentAvatar, AgentStatus } from "./agent-identity";
import { MemberStats } from "./member-stats";
import { useReturnFocus } from "./return-focus";
import { when } from "./routine-format";
import { useAgents } from "./use-agents";
import { useGroups, useOpenGroup } from "./use-groups";
import { useWorkspaceStore } from "./workspace-store";

const onError = (error: Error) => toast.error(error.message);

function GroupAvatars({
  group,
  className,
}: {
  group: Group;
  className?: string;
}) {
  return (
    <span
      className={cn("flex shrink-0 -space-x-2", className)}
      aria-hidden="true"
    >
      {group.participants
        .filter((p) => p.member)
        .slice(0, 3)
        .map((p) => (
          <AgentAvatar
            key={p.agent_id}
            agent={{ id: p.agent_id }}
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
  // Where the group works. A text field for now: the folder picker is the desktop's job, and a
  // typed path is honest about what will be used.
  const [cwd, setCwd] = useState("");
  const [chosen, setChosen] = useState<string[]>(members);
  const { agents } = useAgents();
  const { create } = useGroupActions();
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
            create.mutate(
              {
                name: name.trim(),
                goal,
                members: chosen,
                // Omitted when empty: "no folder" is a state the store keeps, not an empty path
                // pretending to be one.
                ...(cwd.trim().length === 0 ? {} : { cwd: cwd.trim() }),
              },
              {
                onSettled: () => {
                  sendingRef.current = false;
                },
                onError,
                onSuccess: (g) => {
                  setOpen(false);
                  setName("");
                  setGoal("");
                  setCwd("");
                  openGroup(g.id);
                },
              },
            );
          }}
        >
          <label className="grid gap-2 text-sm">
            {translateText("groups.fields.name")}
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              required
            />
          </label>
          <label className="grid gap-2 text-sm">
            {translateText("groups.fields.cwd")}
            <Input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder={translateText("groups.fields.cwdPlaceholder")}
              spellCheck={false}
              className="font-mono"
            />
            <span className="text-xs text-muted-foreground">
              {translateText("groups.fields.cwdHelp")}
            </span>
          </label>
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
              disabled={!name.trim() || !chosen.length || create.isPending}
            >
              {translateText("groups.actions.createGroup")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The conversation list's plus on mobile: a new group or a new agent. */
function CreateMenu() {
  const { t: translateText } = useTranslation([
    "chat",
    "agents",
    "artifacts",
    "common",
    "settings",
  ] as const);
  const [group, setGroup] = useState(false);
  const { openEditor } = useAgents();
  // Opened once the menu has given focus back to the plus, so that closing
  // the dialog returns there rather than to the removed menu item.
  const choiceRef = useRef<() => void>(undefined);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label={translateText("common:actions.new")}
            className="-mr-2 size-11"
          >
            <PlusIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          collisionPadding={8}
          className="w-auto"
          onCloseAutoFocus={() => {
            choiceRef.current?.();
            choiceRef.current = undefined;
          }}
        >
          <DropdownMenuItem
            className="min-h-11 text-sm"
            onSelect={() => (choiceRef.current = () => setGroup(true))}
          >
            <UsersThreeIcon aria-hidden="true" />
            {translateText("groups.actions.create")}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="min-h-11 text-sm"
            onSelect={() => (choiceRef.current = () => openEditor())}
          >
            <RobotIcon aria-hidden="true" />
            {translateText("agents:actions.create")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateGroup open={group} onOpenChange={setGroup} />
    </>
  );
}

export function GroupList({ compact = false }: { compact?: boolean }) {
  const { t: translateText } = useTranslation([
    "chat",
    "agents",
    "artifacts",
    "common",
    "settings",
  ] as const);
  const { groups, current } = useGroups();
  const open = useOpenGroup();
  const shown = groups.filter(
    (g) => !g.archived && (!compact || g.kind === "group"),
  );
  return (
    <section
      className={cn(
        "min-h-0",
        compact ? "mt-5 px-2" : "flex-1 overflow-y-auto px-3",
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between px-2",
          // The list scrolls under its plus, which stays in reach.
          compact ? "h-9" : "sticky top-0 z-10 h-11 bg-background",
        )}
      >
        <h2 className="text-xs font-medium text-muted-foreground">
          {compact
            ? translateText("groups.title")
            : translateText("history.recentChats")}
        </h2>
        {compact ? <CreateGroup /> : <CreateMenu />}
      </div>
      <ul className="space-y-px">
        {shown.map((g) => (
          <li key={g.id}>
            <button
              type="button"
              onClick={() => open(g.id)}
              title={g.name}
              className={cn(
                "flex w-full items-center gap-2 px-2 text-left outline-none duration-[60ms] hover:bg-sidebar-accent focus-visible:ring-1 focus-visible:ring-ring",
                compact ? "h-9" : "min-h-18 py-3",
                current?.id === g.id && compact && "bg-sidebar-accent",
              )}
            >
              <GroupAvatars group={g} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm">{g.name}</span>
                  {!compact && g.last_message_at && (
                    <time
                      dateTime={g.last_message_at}
                      className="shrink-0 text-xs text-muted-foreground tabular-nums"
                    >
                      {when(g.last_message_at).replace(
                        `${translateText("common:time.today")} `,
                        "",
                      )}
                    </time>
                  )}
                </span>
                {!compact && (
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {g.preview ||
                      (g.kind === "direct"
                        ? translateText("groups.directChat")
                        : translateText("history.noMessages"))}
                  </span>
                )}
              </span>
              {g.unread > 0 && (
                <span className="shrink-0 text-xs tabular-nums">
                  {g.unread}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {!shown.length && (
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
  const { update } = useGroupActions();
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
                className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-2 text-left outline-none duration-[60ms] hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
              >
                <GroupAvatars group={g} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{g.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {g.last_message_at && `${when(g.last_message_at)} · `}
                    {g.preview ||
                      (g.kind === "direct"
                        ? translateText("groups.directChat")
                        : translateText("history.noMessages"))}
                  </span>
                </span>
              </button>
              <Button
                size="xs"
                variant="outline"
                disabled={update.isPending}
                onClick={() =>
                  update.mutate({ id: g.id, archived: false }, { onError })
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
  const { data: chat } = useQuery(chatQueryOptions());
  const { current: group, groups } = useGroups();
  const { agents, openEditor } = useAgents();
  const { update, member } = useGroupActions();
  const [edit, setEdit] = useState(false);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [decided, setDecided] = useState("");
  const { data: board } = useTasks();
  const updateTask = useUpdateTask();
  const [linkTask, setLinkTask] = useState(false);
  const [invite, setInvite] = useState(false);
  const [removing, setRemoving] = useState<Group["participants"][number]>();
  const focused = useWorkspaceStore((state) => state.focusedAgentId);
  const setFocusedAgent = useWorkspaceStore((state) => state.setFocusedAgent);
  if (!group) return null;
  const members = group.participants.filter((p) => p.member);
  const linked = board?.tasks.filter((t) => t.group_id === group.id) ?? [];
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
                setGoal(group.goal);
                setDecided(group.decided);
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
                  { id: group.id, archived: !group.archived },
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
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-1">
        {members.map((p) => {
          const agent = agents.find((a) => a.id === p.agent_id);
          const active = chat?.messages.find(
            (m) =>
              m.agent_id === p.agent_id &&
              ["responding", "waiting_for_input", "stopping"].includes(
                m.status,
              ),
          );
          const elsewhere =
            active && active.group_id !== group.id
              ? groups.find((g) => g.id === active.group_id)?.name
              : undefined;
          const removable = group.kind === "group" && members.length > 1;
          return (
            <li
              key={p.agent_id}
              className={cn(
                "flex min-w-0 items-start gap-2 border px-2 py-1.5",
                // Focused is a frame around the card, not a different card: the numbers stay where
                // they were, so comparing two members does not mean re-learning the layout.
                focused === p.agent_id ? "border-foreground" : "border-border",
              )}
            >
              <AgentAvatar agent={{ id: p.agent_id }} />
              {/* Pressing the member is the same action as pressing its card anywhere else: the
                  chat narrows to it. The menu beside it is the other thing a member has. */}
              <button
                type="button"
                // Press to focus, press again to let go. The frame is the whole state: white
                // border = narrowed to this member, and the same press takes it back.
                onClick={() =>
                  setFocusedAgent(focused === p.agent_id ? null : p.agent_id)
                }
                title={translateText("groups.members.focus", { name: p.name })}
                className="min-w-0 flex-1 text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <span className="block truncate" title={p.name}>
                  {p.name}{" "}
                  <span className="text-xs text-muted-foreground">
                    {elsewhere ? (
                      translateText("groups.members.replyingElsewhere", {
                        groupName: elsewhere,
                      })
                    ) : agent ? (
                      <AgentStatus status={agent.status} />
                    ) : (
                      translateText("common:status.deleted")
                    )}
                  </span>
                </span>
                {/* The member's own session: what it has spent here, what it is chasing. */}
                <MemberStats sessionId={p.session_id ?? undefined} />
              </button>
              {(agent || removable) && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={translateText(
                        "common:accessibility.itemActions",
                        {
                          name: p.name,
                        },
                      )}
                    >
                      <DotsThreeIcon aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {agent && (
                      <DropdownMenuItem onSelect={() => openEditor(agent.id)}>
                        {translateText("settings:title")}
                      </DropdownMenuItem>
                    )}
                    {removable && (
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setRemoving(p)}
                      >
                        {translateText("common:actions.remove")}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
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
                name: removing?.name,
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
              disabled={member.isPending}
              onClick={() =>
                removing &&
                member.mutate(
                  {
                    groupId: group.id,
                    agentId: removing.agent_id,
                    member: false,
                  },
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
                  disabled={updateTask.isPending}
                  onClick={() =>
                    updateTask.mutate(
                      { id: t.id, changes: { group_id: "" } },
                      { onError },
                    )
                  }
                >
                  {translateText("groups.relatedTasks.unlink")}
                </Button>
              </div>
            ))}
            {board?.tasks
              .filter((t) => t.group_id !== group.id)
              .map((t) => (
                <Button
                  key={t.id}
                  variant="ghost"
                  className="justify-start truncate"
                  disabled={updateTask.isPending || group.archived}
                  aria-label={translateText("groups.relatedTasks.linkLabel", {
                    number: t.number,
                    title: t.title,
                  })}
                  onClick={() =>
                    updateTask.mutate(
                      { id: t.id, changes: { group_id: group.id } },
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
                  id: group.id,
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
              .filter((a) => !members.some((p) => p.agent_id === a.id))
              .map((a) => (
                <Button
                  key={a.id}
                  variant="ghost"
                  className="justify-start"
                  disabled={member.isPending}
                  onClick={() =>
                    member.mutate(
                      { groupId: group.id, agentId: a.id, member: true },
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
  const { data } = useArtifacts();
  if (!group) return null;
  const artifacts = data?.artifacts.filter((a) => a.group_id === group.id);
  if (!data) return <Loading rows={2} />;
  if (!artifacts?.length)
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
