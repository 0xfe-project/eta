import type { Task, TaskDetail, TaskStatus } from "@/queries/tasks";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { ChatCircleIcon } from "@phosphor-icons/react/ChatCircle";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { KanbanIcon } from "@phosphor-icons/react/Kanban";
import { ListIcon } from "@phosphor-icons/react/List";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  useDeleteTask,
  useTask,
  useTasks,
  useUpdateTask,
} from "@/queries/tasks";
import { PageHeader } from "./app-shell";
import { when } from "./routine-format";
import {
  ago,
  assigneeLabel,
  isActive,
  statuses,
  statusLabel,
} from "./task-format";
import { useTaskNav } from "./task-nav";
import { StatusIcon } from "./task-status-icon";
import {
  AssigneeRow,
  CommentBox,
  Description,
  EditableTitle,
  FeedbackDialog,
  StatusSelect,
  TaskForm,
  Timeline,
  Working,
} from "./tasks";

// The task board as a full-window page: every task as rows grouped by status
// or as a board to drag them across, and a task with its properties beside it.

const showError = (error: Error) => toast.error(error.message);

/** The board reads left to right the way work moves. */
const flow: TaskStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "blocked",
  "in_review",
  "done",
  "cancelled",
];
/** Done and cancelled start folded in the list: they are the past. */
const folded = new Set<TaskStatus>(["done", "cancelled"]);

const scopes = [
  { value: "all", label: "全部" },
  { value: "user", label: "我的" },
  { value: "remote", label: "智能体" },
] as const;

function RunState({ task }: { task: Task }) {
  if (isActive(task.run_status)) return <Working />;
  if (task.run_status === "failed")
    return <span className="text-destructive">运行失败</span>;
  return null;
}

function Comments({ count }: { count: number }) {
  return count ? (
    <span className="inline-flex items-center gap-0.5">
      <ChatCircleIcon aria-label="评论" />
      {count}
    </span>
  ) : null;
}

/** The status icon as a menu: change a task's status without opening it. */
function StatusMenu({ task }: { task: Task }) {
  const update = useUpdateTask();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`状态：${statusLabel(task.status)}，修改`}
          className="flex size-7 shrink-0 items-center justify-center outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring"
        >
          <StatusIcon status={task.status} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40">
        {statuses.map((s) => (
          <DropdownMenuItem
            key={s.value}
            disabled={s.value === task.status}
            onSelect={() =>
              update.mutate(
                { id: task.id, changes: { status: s.value } },
                { onError: showError },
              )
            }
          >
            <StatusIcon status={s.value} />
            {s.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- list ---------------------------------------------------------------------------

function ListView({
  tasks,
  onCreate,
}: {
  tasks: Task[];
  onCreate: (status: TaskStatus) => void;
}) {
  const [, setNav] = useTaskNav();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (status: TaskStatus) => open[status] ?? !folded.has(status);
  return (
    <div className="pb-6">
      {statuses.map(({ value, label }) => {
        const group = tasks.filter((t) => t.status === value);
        if (!group.length) return null;
        return (
          <section key={value} aria-label={label}>
            <div className="sticky top-0 z-10 flex h-9 items-center border-b bg-muted px-2 sm:px-4">
              <button
                type="button"
                aria-expanded={isOpen(value)}
                onClick={() => setOpen({ ...open, [value]: !isOpen(value) })}
                className="flex h-full flex-1 items-center gap-2 px-2 text-left text-xs font-medium outline-none focus-visible:underline"
              >
                {isOpen(value) ? (
                  <CaretDownIcon aria-hidden="true" className="size-3" />
                ) : (
                  <CaretRightIcon aria-hidden="true" className="size-3" />
                )}
                <StatusIcon status={value} className="size-3.5" />
                {label}
                <span className="text-muted-foreground tabular-nums">
                  {group.length}
                </span>
              </button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`新建${label}任务`}
                title="新建"
                onClick={() => onCreate(value)}
              >
                <PlusIcon aria-hidden="true" />
              </Button>
            </div>
            {isOpen(value) ? (
              <ul>
                {group.map((task) => (
                  <li
                    key={task.id}
                    className="flex h-10 items-center gap-1 border-b px-2 transition-colors duration-[60ms] ease-linear hover:bg-muted/40 sm:px-4"
                  >
                    <StatusMenu task={task} />
                    <button
                      type="button"
                      onClick={() => void setNav({ task: task.id })}
                      className="grid h-full min-w-0 flex-1 grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-2 text-left outline-none focus-visible:underline sm:grid-cols-[3rem_minmax(0,1fr)_auto_minmax(0,12rem)_4.5rem]"
                    >
                      <span className="text-xs text-muted-foreground tabular-nums">
                        #{task.number}
                      </span>
                      <span className="truncate text-sm">{task.title}</span>
                      <span className="flex items-center gap-3 text-xs text-muted-foreground tabular-nums">
                        <RunState task={task} />
                        <Comments count={task.comments} />
                      </span>
                      <span className="hidden truncate text-xs text-muted-foreground sm:block">
                        {assigneeLabel(task.assignee)}
                      </span>
                      <span className="hidden text-right text-xs text-muted-foreground tabular-nums sm:block">
                        {ago(task.updated_at)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

// --- board --------------------------------------------------------------------------

const dragType = "application/x-axp-task";

function Card({ task }: { task: Task }) {
  const [, setNav] = useTaskNav();
  return (
    <li>
      <button
        type="button"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(dragType, task.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={() => void setNav({ task: task.id })}
        className="block w-full space-y-1.5 border bg-card p-2.5 text-left transition-colors duration-[60ms] ease-linear outline-none hover:border-foreground/30 focus-visible:ring-1 focus-visible:ring-ring active:cursor-grabbing"
      >
        <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
          #{task.number}
          <span className="ml-auto flex items-center gap-2">
            <RunState task={task} />
            <Comments count={task.comments} />
          </span>
        </span>
        <span className="line-clamp-3 text-sm">{task.title}</span>
        <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums">
          <span className="truncate">{assigneeLabel(task.assignee)}</span>
          <span className="shrink-0">{ago(task.updated_at)}</span>
        </span>
      </button>
    </li>
  );
}

function BoardView({
  tasks,
  onCreate,
}: {
  tasks: Task[];
  onCreate: (status: TaskStatus) => void;
}) {
  const update = useUpdateTask();
  const [over, setOver] = useState<TaskStatus | null>(null);
  const columns = flow.filter(
    (status) =>
      status !== "cancelled" || tasks.some((t) => t.status === status),
  );
  return (
    <div className="flex h-full gap-3 overflow-x-auto p-4 sm:px-6">
      {columns.map((status) => {
        const group = tasks.filter((t) => t.status === status);
        const label = statusLabel(status);
        return (
          <section
            key={status}
            aria-label={label}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(dragType)) return;
              e.preventDefault();
              setOver(status);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node))
                setOver(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData(dragType);
              const task = tasks.find((t) => t.id === id);
              if (task && task.status !== status)
                update.mutate(
                  { id, changes: { status } },
                  { onError: showError },
                );
            }}
            className={cn(
              "flex w-72 shrink-0 flex-col bg-muted/50 outline-offset-[-1px] transition-colors duration-[60ms] ease-linear",
              over === status && "bg-muted outline outline-foreground/30",
            )}
          >
            <div className="flex h-9 shrink-0 items-center gap-2 pr-1 pl-2.5 text-xs font-medium">
              <StatusIcon status={status} className="size-3.5" />
              {label}
              <span className="text-muted-foreground tabular-nums">
                {group.length}
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                className="ml-auto"
                aria-label={`新建${label}任务`}
                title="新建"
                onClick={() => onCreate(status)}
              >
                <PlusIcon aria-hidden="true" />
              </Button>
            </div>
            <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-1.5 pb-1.5">
              {group.map((task) => (
                <Card key={task.id} task={task} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

// --- task ---------------------------------------------------------------------------

function Property({
  label,
  top = false,
  children,
}: {
  label: string;
  top?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className={cn("text-muted-foreground", top && "self-start pt-1")}>
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/** The pull requests the task delivered, newest first. */
function deliverables(task: TaskDetail) {
  return task.activity
    .filter((a) => a.kind === "deliverable" && typeof a.data.url === "string")
    .map((a) => ({
      id: a.id,
      url: a.data.url as string,
      title:
        (typeof a.data.title === "string" && a.data.title) ||
        (a.data.url as string).replace("https://github.com/", ""),
    }))
    .reverse();
}

function TaskPage({ id }: { id: string }) {
  const [, setNav] = useTaskNav();
  const { data: task, isPending, error } = useTask(id);
  const update = useUpdateTask();
  const remove = useDeleteTask();
  const [feedback, setFeedback] = useState(false);
  const back = () => void setNav({ task: null });
  const crumbs = (
    <>
      <button
        type="button"
        onClick={back}
        className="text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
      >
        任务
      </button>
      <CaretRightIcon
        aria-hidden="true"
        className="size-3 text-muted-foreground"
      />
      {task ? (
        <span className="truncate tabular-nums">#{task.number}</span>
      ) : null}
    </>
  );
  if (!task)
    return (
      <>
        <PageHeader title={crumbs} />
        <main id="main" className="px-4 py-6 sm:px-6">
          {isPending ? null : (
            <p className="text-sm text-muted-foreground">
              {error?.message ?? "这个任务已不存在。"}
            </p>
          )}
        </main>
      </>
    );
  const links = deliverables(task);
  return (
    <>
      <PageHeader title={crumbs}>
        <Button size="sm" variant="outline" onClick={() => setFeedback(true)}>
          <RobotIcon aria-hidden="true" />
          让智能体反馈
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="更多">
              <DotsThreeIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setFeedback(true)}>
              让智能体反馈
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() =>
                remove.mutate(task.id, { onSuccess: back, onError: showError })
              }
            >
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PageHeader>
      <main
        id="main"
        className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1fr)_18rem] lg:overflow-hidden"
      >
        <div className="lg:overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-8">
            <div className="space-y-1">
              <EditableTitle key={task.title} task={task} className="text-xl" />
              <p className="text-xs text-muted-foreground">
                {task.created_by.kind === "agent"
                  ? `由 ${task.created_by.agent_name ?? "智能体"} 创建`
                  : "由我创建"}{" "}
                · {when(task.created_at)}
              </p>
            </div>
            <Description key={task.description} task={task} />
            <section aria-labelledby="task-activity" className="space-y-3">
              <h2 id="task-activity" className="text-sm font-semibold">
                动态
              </h2>
              <Timeline task={task} />
              <CommentBox task={task} />
            </section>
          </div>
        </div>
        <aside
          aria-label="属性"
          className="space-y-6 border-t px-4 py-5 text-xs sm:px-8 lg:overflow-y-auto lg:border-t-0 lg:border-l lg:px-4"
        >
          <dl className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3">
            <Property label="状态">
              <span className="flex items-center gap-2">
                <StatusIcon status={task.status} />
                <StatusSelect
                  className="flex-1"
                  value={task.status}
                  onChange={(status) =>
                    update.mutate(
                      { id: task.id, changes: { status } },
                      { onError: showError },
                    )
                  }
                />
              </span>
            </Property>
            <Property label="指派给" top>
              <AssigneeRow task={task} />
            </Property>
            <Property label="更新于">
              <span className="tabular-nums">{when(task.updated_at)}</span>
            </Property>
          </dl>
          {links.length ? (
            <section
              aria-labelledby="task-deliverables"
              className="space-y-1.5"
            >
              <h2
                id="task-deliverables"
                className="font-medium text-muted-foreground"
              >
                交付
              </h2>
              <ul className="space-y-1">
                {links.map((link) => (
                  <li key={link.id}>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1.5 underline-offset-4 hover:underline"
                    >
                      <GitPullRequestIcon
                        aria-hidden="true"
                        className="size-3.5 shrink-0"
                      />
                      <span className="truncate">{link.title}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </aside>
      </main>
      <FeedbackDialog task={task} open={feedback} onOpenChange={setFeedback} />
    </>
  );
}

// --- page ---------------------------------------------------------------------------

export function TaskBoard() {
  const [nav, setNav] = useTaskNav();
  const { data } = useTasks();
  const [newStatus, setNewStatus] = useState<TaskStatus>("todo");
  const id = nav.task && nav.task !== "new" ? nav.task : null;
  if (id) return <TaskPage id={id} />;

  const tasks = (data?.tasks ?? []).filter(
    (task) => nav.scope === "all" || task.assignee.kind === nav.scope,
  );
  const create = (status: TaskStatus = "todo") => {
    setNewStatus(status);
    void setNav({ task: "new" });
  };
  return (
    <>
      <PageHeader
        title={
          <>
            任务
            {data ? (
              <span className="font-normal text-muted-foreground tabular-nums">
                {tasks.length}
              </span>
            ) : null}
          </>
        }
      >
        <Tabs
          value={nav.scope}
          onValueChange={(scope) =>
            void setNav({ scope: scope as typeof nav.scope })
          }
          className="hidden sm:flex"
        >
          <TabsList aria-label="指派范围" className="gap-1">
            {scopes.map((s) => (
              <TabsTrigger
                key={s.value}
                value={s.value}
                className="px-2 text-xs"
              >
                {s.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Tabs
          value={nav.layout}
          onValueChange={(layout) =>
            void setNav({ layout: layout as typeof nav.layout })
          }
        >
          <TabsList aria-label="布局">
            <TabsTrigger
              value="list"
              aria-label="列表"
              title="列表"
              className="px-2"
            >
              <ListIcon aria-hidden="true" />
            </TabsTrigger>
            <TabsTrigger
              value="board"
              aria-label="看板"
              title="看板"
              className="px-2"
            >
              <KanbanIcon aria-hidden="true" />
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Button size="sm" onClick={() => create()}>
          <PlusIcon aria-hidden="true" />
          <span className="hidden sm:inline">新建任务</span>
          <span className="sr-only sm:hidden">新建任务</span>
        </Button>
      </PageHeader>
      <main
        id="main"
        className={cn(
          "min-h-0 flex-1",
          nav.layout === "board" ? "overflow-hidden" : "overflow-y-auto",
        )}
      >
        {!data ? null : data.tasks.length === 0 ? (
          <div className="mx-auto max-w-md px-4 py-16 text-center">
            <Button
              variant="outline"
              className="h-20 w-full border-dashed text-muted-foreground"
              onClick={() => create()}
            >
              <PlusIcon aria-hidden="true" />
              新建任务
            </Button>
          </div>
        ) : nav.layout === "board" ? (
          <BoardView tasks={tasks} onCreate={create} />
        ) : (
          <ListView tasks={tasks} onCreate={create} />
        )}
      </main>
      <Dialog
        open={nav.task === "new"}
        onOpenChange={(open) => !open && void setNav({ task: null })}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>新建任务</DialogTitle>
          </DialogHeader>
          <TaskForm
            key={newStatus}
            bare
            initialStatus={newStatus}
            onDone={(created) => void setNav({ task: created ?? null })}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
