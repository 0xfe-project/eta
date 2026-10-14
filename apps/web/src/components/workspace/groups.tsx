import type { Group } from "@/queries/chat";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { UsersThreeIcon } from "@phosphor-icons/react/UsersThree";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
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
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlled ?? uncontrolled;
  const setOpen = onOpenChange ?? setUncontrolled;
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
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
            <Button variant="ghost" size="icon-xs" aria-label="新建群">
              <PlusIcon />
            </Button>
          )}
        </DialogTrigger>
      )}
      <DialogContent onCloseAutoFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>新建群</DialogTitle>
          <DialogDescription>选几位智能体，一起讨论一件事。</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (sendingRef.current) return;
            sendingRef.current = true;
            create.mutate(
              { name: name.trim(), goal, members: chosen },
              {
                onSettled: () => {
                  sendingRef.current = false;
                },
                onError,
                onSuccess: (g) => {
                  setOpen(false);
                  setName("");
                  setGoal("");
                  openGroup(g.id);
                },
              },
            );
          }}
        >
          <label className="grid gap-2 text-sm">
            群名
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              required
            />
          </label>
          <label className="grid gap-2 text-sm">
            目标（可选）
            <Textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              maxLength={10000}
            />
          </label>
          <fieldset className="grid max-h-64 gap-1 overflow-y-auto">
            <legend className="mb-2 text-sm">成员</legend>
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
              创建群
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The conversation list's plus on mobile: a new group or a new agent. */
function CreateMenu() {
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
            aria-label="新建"
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
            新建群
          </DropdownMenuItem>
          <DropdownMenuItem
            className="min-h-11 text-sm"
            onSelect={() => (choiceRef.current = () => openEditor())}
          >
            <RobotIcon aria-hidden="true" />
            新建智能体
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateGroup open={group} onOpenChange={setGroup} />
    </>
  );
}

export function GroupList({ compact = false }: { compact?: boolean }) {
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
          {compact ? "群" : "最近对话"}
        </h2>
        {compact ? <CreateGroup /> : <CreateMenu />}
      </div>
      <ul className="grid gap-px">
        {shown.map((g) => (
          <li key={g.id}>
            <button
              type="button"
              onClick={() => open(g.id)}
              className={cn(
                "flex w-full items-center gap-2 px-2 text-left outline-none transition-colors duration-[60ms] hover:bg-sidebar-accent focus-visible:ring-1 focus-visible:ring-ring",
                compact ? "h-9" : "min-h-18 py-3",
                current?.id === g.id && compact && "bg-sidebar-accent",
              )}
            >
              <GroupAvatars group={g} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm">{g.name}</span>
                  {!compact && g.last_message_at && (
                    <time
                      dateTime={g.last_message_at}
                      className="shrink-0 text-xs text-muted-foreground tabular-nums"
                    >
                      {when(g.last_message_at).replace(/^今天 /u, "")}
                    </time>
                  )}
                </span>
                {!compact && (
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {g.preview || (g.kind === "direct" ? "私聊" : "还没有消息")}
                  </span>
                )}
              </span>
              {g.unread > 0 && (
                <span className="text-xs tabular-nums">{g.unread}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {!shown.length && (
        <p className="px-2 py-6 text-xs text-muted-foreground">还没有对话</p>
      )}
    </section>
  );
}

/** Settings' 已归档: archived conversations, to open or bring back. */
export function ArchivedGroups() {
  const { groups } = useGroups();
  const open = useOpenGroup();
  const { update } = useGroupActions();
  const setSettings = useWorkspaceStore((s) => s.setSettings);
  const archived = groups.filter((g) => g.archived);
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">已归档</h2>
      {archived.length ? (
        <ul className="grid gap-px">
          {archived.map((g) => (
            <li key={g.id} className="flex min-h-14 items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setSettings((state) => ({ ...state, open: false }));
                  open(g.id);
                }}
                className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-2 text-left outline-none transition-colors duration-[60ms] hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
              >
                <GroupAvatars group={g} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{g.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {g.last_message_at && `${when(g.last_message_at)} · `}
                    {g.preview || (g.kind === "direct" ? "私聊" : "还没有消息")}
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
                取消归档
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">没有已归档的对话。</p>
      )}
    </div>
  );
}

export function GroupBar({
  group,
  onInfo,
}: {
  group?: Group;
  onInfo: () => void;
}) {
  return (
    <div className="hidden shrink-0 justify-center px-3 pt-3 pb-2 md:flex">
      {group && (
        <button
          type="button"
          onClick={onInfo}
          className="group flex max-w-full flex-col items-center outline-none"
          aria-label={`${group.name}，${group.kind === "direct" ? "智能体设置" : "查看群信息"}`}
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
          <span className="relative -mt-2.5 max-w-48 truncate border bg-background px-2.5 py-0.5 text-sm font-medium shadow-sm group-hover:bg-muted group-focus-visible:ring-1 group-focus-visible:ring-ring">
            {group.name}
          </span>
        </button>
      )}
    </div>
  );
}

export function GroupInfo() {
  const { data: chat } = useQuery(chatQueryOptions());
  const { current: group, groups } = useGroups();
  const { agents, openEditor } = useAgents();
  const { update, member } = useGroupActions();
  const [edit, setEdit] = useState(false);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [decided, setDecided] = useState("");
  const { data: board } = useTasks();
  const { data: artifacts } = useArtifacts();
  const updateTask = useUpdateTask();
  const [linkTask, setLinkTask] = useState(false);
  const [invite, setInvite] = useState(false);
  if (!group)
    return (
      <p className="p-4 text-sm text-muted-foreground">选一个群开始讨论。</p>
    );
  const members = group.participants.filter((p) => p.member);
  return (
    <div className="grid gap-6 p-2">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate font-medium">{group.name}</h2>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            setName(group.name);
            setGoal(group.goal);
            setDecided(group.decided);
            setEdit(true);
          }}
        >
          编辑
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            update.mutate(
              { id: group.id, archived: !group.archived },
              { onError },
            )
          }
        >
          {group.archived ? "取消归档" : "归档"}
        </Button>
      </div>
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs text-muted-foreground">
            {group.kind === "direct" ? "私聊" : `成员 · ${members.length}`}
          </h3>
          {group.kind === "group" && !group.archived && (
            <Button size="xs" variant="ghost" onClick={() => setInvite(true)}>
              邀请
            </Button>
          )}
        </div>
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
          return (
            <div key={p.agent_id} className="flex min-h-12 items-center gap-2">
              <AgentAvatar agent={{ id: p.agent_id }} />
              <div className="min-w-0 flex-1 text-sm">
                <span className="block truncate">{p.name}</span>
                <span className="text-xs text-muted-foreground">
                  {elsewhere ? (
                    `在「${elsewhere}」回复中`
                  ) : agent ? (
                    <AgentStatus status={agent.status} />
                  ) : (
                    "已删除"
                  )}
                </span>
              </div>
              {agent && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => openEditor(agent.id)}
                >
                  设置
                </Button>
              )}
              {group.kind === "group" && members.length > 1 && (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={member.isPending}
                  onClick={() =>
                    member.mutate(
                      { groupId: group.id, agentId: p.agent_id, member: false },
                      { onError },
                    )
                  }
                >
                  移除
                </Button>
              )}
            </div>
          );
        })}
      </section>
      <section>
        <h3 className="mb-3 text-xs text-muted-foreground">群简报</h3>
        <div className="space-y-4 border-l-2 pl-3 text-sm">
          <div>
            <h4 className="mb-1 font-medium">目标</h4>
            <p className="whitespace-pre-wrap text-muted-foreground">
              {group.goal || "还没有目标"}
            </p>
          </div>
          <div>
            <h4 className="mb-1 font-medium">已决定</h4>
            <p className="whitespace-pre-wrap text-muted-foreground">
              {group.decided || "还没有记录决定"}
            </p>
          </div>
        </div>
      </section>
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs text-muted-foreground">相关任务</h3>
          <Button size="xs" variant="ghost" onClick={() => setLinkTask(true)}>
            关联任务
          </Button>
        </div>
        <div className="space-y-2">
          {board?.tasks
            .filter((t) => t.group_id === group.id)
            .map((t) => (
              <div key={t.id}>
                <ActivityRefCard
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
                  onClick={() =>
                    updateTask.mutate(
                      { id: t.id, changes: { group_id: "" } },
                      { onError },
                    )
                  }
                >
                  解除关联
                </Button>
              </div>
            ))}
        </div>
      </section>
      <section>
        <h3 className="mb-2 text-xs text-muted-foreground">Artifacts</h3>
        <div className="space-y-2">
          {artifacts?.artifacts
            .filter((a) => a.group_id === group.id)
            .map((a) => (
              <ActivityRefCard
                key={a.id}
                value={{
                  kind: "artifact",
                  id: a.id,
                  title: a.title,
                  number: a.versions[0]?.number,
                }}
              />
            ))}
        </div>
      </section>
      <Dialog open={linkTask} onOpenChange={setLinkTask}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>关联任务</DialogTitle>
            <DialogDescription>
              任务只关联一个群，重新关联会替换之前的群。
            </DialogDescription>
          </DialogHeader>
          <div className="grid max-h-80 gap-1 overflow-y-auto">
            {board?.tasks
              .filter((t) => t.group_id !== group.id)
              .map((t) => (
                <Button
                  key={t.id}
                  variant="ghost"
                  className="justify-start truncate"
                  disabled={updateTask.isPending || group.archived}
                  onClick={() =>
                    updateTask.mutate(
                      { id: t.id, changes: { group_id: group.id } },
                      { onError, onSuccess: () => setLinkTask(false) },
                    )
                  }
                >
                  #{t.number} {t.title}
                </Button>
              ))}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={edit} onOpenChange={setEdit}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑群信息</DialogTitle>
            <DialogDescription>
              记录当前目标和已经达成的决定。
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
                群名
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={100}
                  required
                />
              </label>
            )}
            <label className="grid gap-2 text-sm">
              目标
              <Textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                maxLength={10000}
              />
            </label>
            <label className="grid gap-2 text-sm">
              已决定
              <Textarea
                value={decided}
                onChange={(e) => setDecided(e.target.value)}
                maxLength={10000}
              />
            </label>
            <DialogFooter>
              <Button disabled={update.isPending}>保存</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={invite} onOpenChange={setInvite}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>邀请智能体</DialogTitle>
            <DialogDescription>
              加入后可以查看群聊，并在被 @ 时回复。
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
    </div>
  );
}
