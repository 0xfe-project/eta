import type { WorkspaceState } from "./workspace-store";
import type { Task, TaskStatus } from "@/queries/tasks";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { KanbanIcon } from "@phosphor-icons/react/Kanban";
import { ListIcon } from "@phosphor-icons/react/List";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Empty, LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useAgentList } from "@/queries/agents";
import {
  useDeleteTask,
  useTask,
  useTasks,
  useUpdateTask,
} from "@/queries/tasks";
import { wireErrorMessage } from "@/queries/wire";
import { PageHeader } from "./app-shell";
import { BackToTop } from "./back-to-top";
import { when } from "./routine-format";
import {
  actorName,
  ago,
  createdBy,
  statuses,
  statusLabel,
} from "./task-format";
import { useTaskNav } from "./task-nav";
import { StatusIcon } from "./task-status-icon";
import {
  CommentBox,
  Comments,
  Description,
  EditableTitle,
  LiveRuns,
  Question,
  RunState,
  TaskMissing,
  TaskProperties,
  Timeline,
} from "./tasks";
import { useWorkspaceStore } from "./workspace-store";

// The task board as a full-window page: every task as rows grouped by status
// or as a board to drag them across, or one open task in their place. The
// task lays itself out by its own width (container queries), not the window's.

const showError = (error: Error) => toast.error(wireErrorMessage(error));

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

/** The status icon as a menu: change a task's status without opening it. */
function StatusMenu({ task }: { task: Task }) {
  const { t: translateText } = useTranslation([
    "tasks",
    "common",
    "navigation",
  ] as const);
  const update = useUpdateTask();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={translateText("status.changeLabel", {
            status: statusLabel(task.status),
          })}
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
                { taskId: task.id, status: s.value },
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
  selected,
  hidden,
}: {
  tasks: readonly Task[];
  /** The task last open, marked so the list reads as left. */
  selected: string | null;
  hidden: boolean;
}) {
  useTranslation(["tasks", "common", "navigation"] as const);
  const [, setNav] = useTaskNav();
  const { agents } = useAgentList();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const selectedRef = useRef<HTMLButtonElement>(null);
  // Back from a task, focus returns to its row.
  useEffect(() => {
    if (!hidden) selectedRef.current?.focus();
  }, [hidden]);
  // Every group starts open; a click folds it.
  const isOpen = (status: TaskStatus) => open[status] ?? true;
  return (
    <div className="mx-auto max-w-content pb-6">
      {statuses.map(({ value, label }) => {
        const group = tasks.filter((t) => t.status === value);
        if (!group.length) return null;
        return (
          <section key={value} aria-label={label}>
            <div className="sticky top-0 z-10 flex h-9 items-center border-b bg-muted">
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
            </div>
            {isOpen(value) ? (
              <ul>
                {group.map((task) => (
                  <li
                    key={task.id}
                    className={cn(
                      "flex h-10 items-center gap-1 border-b duration-[60ms] ease-linear hover:bg-muted/40",
                      task.id === selected && "bg-muted hover:bg-muted",
                    )}
                  >
                    <StatusMenu task={task} />
                    <button
                      ref={task.id === selected ? selectedRef : undefined}
                      type="button"
                      aria-current={task.id === selected || undefined}
                      onClick={() => void setNav({ task: task.id })}
                      className="grid h-full min-w-0 flex-1 grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-2 text-left outline-none focus-visible:underline @lg:grid-cols-[3rem_minmax(0,1fr)_auto_minmax(0,12rem)_4.5rem]"
                    >
                      <span className="text-xs text-muted-foreground tabular-nums">
                        #{task.number}
                      </span>
                      <span className="truncate text-sm">{task.title}</span>
                      <span className="flex items-center gap-3 text-xs text-muted-foreground tabular-nums">
                        <RunState task={task} />
                        <Comments count={task.comments} />
                      </span>
                      <span className="hidden truncate text-xs text-muted-foreground @lg:block">
                        {actorName(task.createdBy, agents)}
                      </span>
                      <span className="hidden text-right text-xs text-muted-foreground tabular-nums @lg:block">
                        {ago(task.updatedAt)}
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

const dragType = "application/x-eta-task";

function Card({ task }: { task: Task }) {
  useTranslation(["tasks", "common", "navigation"] as const);
  const [, setNav] = useTaskNav();
  const { agents } = useAgentList();
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
        className="block w-full space-y-1.5 border bg-card p-2.5 text-left duration-[60ms] ease-linear outline-none hover:border-foreground/30 focus-visible:ring-1 focus-visible:ring-ring active:cursor-grabbing"
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
          <span className="truncate">{actorName(task.createdBy, agents)}</span>
          <span className="shrink-0">{ago(task.updatedAt)}</span>
        </span>
      </button>
    </li>
  );
}

function BoardView({ tasks }: { tasks: readonly Task[] }) {
  useTranslation(["tasks", "common", "navigation"] as const);
  const update = useUpdateTask();
  const [over, setOver] = useState<TaskStatus | null>(null);
  const columns = flow.filter(
    (status) =>
      status !== "cancelled" || tasks.some((t) => t.status === status),
  );
  return (
    <div className="flex h-full gap-3 overflow-x-auto py-4">
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
                update.mutate({ taskId: id, status }, { onError: showError });
            }}
            className={cn(
              "flex w-72 shrink-0 flex-col bg-muted/50 outline-offset-[-1px] duration-[60ms] ease-linear",
              over === status && "bg-muted outline outline-foreground/30",
            )}
          >
            <div className="flex h-9 shrink-0 items-center gap-2 pr-1 pl-2.5 text-xs font-medium">
              <StatusIcon status={status} className="size-3.5" />
              {label}
              <span className="text-muted-foreground tabular-nums">
                {group.length}
              </span>
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

function TaskPage({ id }: { id: string }) {
  const { t: translateText } = useTranslation([
    "tasks",
    "common",
    "navigation",
  ] as const);
  const [, setNav] = useTaskNav();
  const { task, missing, error } = useTask(id);
  const { agents } = useAgentList();
  const remove = useDeleteTask();
  const back = () => void setNav({ task: null });
  const crumbs = (
    <>
      <button
        type="button"
        onClick={back}
        className="flex items-center gap-1.5 text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
        {translateText("navigation:sections.tasks")}
      </button>
      {task ? (
        <span className="truncate tabular-nums">#{task.number}</span>
      ) : null}
    </>
  );
  if (!task)
    return (
      <>
        <PageHeader title={crumbs} />
        <main
          id="main"
          className="mx-auto w-full max-w-content px-4 py-6 sm:px-8"
        >
          <TaskMissing missing={missing} error={error} />
        </main>
      </>
    );
  return (
    <>
      <PageHeader title={crumbs}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={translateText("navigation:sections.more")}
            >
              <DotsThreeIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              variant="destructive"
              onSelect={() =>
                remove.mutate(
                  { taskId: task.id },
                  { onSuccess: back, onError: showError },
                )
              }
            >
              {translateText("common:actions.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PageHeader>
      <main
        id="main"
        className="mx-auto min-h-0 w-full max-w-content flex-1 overflow-y-auto @2xl:grid @2xl:grid-cols-[minmax(0,1fr)_18rem] @2xl:overflow-hidden"
      >
        <div className="@2xl:overflow-y-auto">
          <div className="space-y-6 px-4 pb-6 sm:px-8">
            {/* Pinned under the page header (任务 and the number) as the rest scrolls. */}
            <div className="sticky top-0 z-10 mb-3 space-y-1 bg-background pt-4 pb-3">
              <EditableTitle task={task} className="text-xl" />
              <p className="text-xs text-muted-foreground tabular-nums">
                {createdBy(task, agents)}
              </p>
            </div>
            <Question task={task} />
            <Description key={task.description} task={task} />
            <section aria-labelledby="task-activity" className="space-y-3">
              <h2 id="task-activity" className="text-sm font-semibold">
                {translateText("details.activityTab")}
              </h2>
              <Timeline task={task} />
              <CommentBox
                task={task}
                top={<LiveRuns task={task} className="space-y-1 pb-1.5" />}
              />
            </section>
          </div>
          <BackToTop className="px-4 sm:px-8" />
        </div>
        <aside
          aria-label={translateText("details.propertiesTab")}
          className="border-t px-4 py-5 text-xs sm:px-8 @2xl:overflow-y-auto @2xl:border-t-0 @2xl:border-l @2xl:px-4"
        >
          <TaskProperties task={task}>
            <dt className="text-xs leading-8 text-muted-foreground">
              {translateText("fields.updatedAt")}
            </dt>
            <dd className="leading-8 tabular-nums">{when(task.updatedAt)}</dd>
          </TaskProperties>
        </aside>
      </main>
    </>
  );
}

// --- page ---------------------------------------------------------------------------

export function TaskBoard() {
  const { t: translateText } = useTranslation([
    "tasks",
    "common",
    "navigation",
  ] as const);
  const [nav] = useTaskNav();
  const { tasks, loaded, error } = useTasks();
  // Remembered in this browser, so the page opens as it was left.
  const layout = useWorkspaceStore((s) => s.workspace.taskLayout ?? "list");
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace);
  const setView = (changes: Pick<WorkspaceState, "taskLayout">) =>
    setWorkspace((workspace) => ({ ...workspace, ...changes }));
  const id = nav.task ?? null;
  const [last, setLast] = useState(id);
  if (id && id !== last) setLast(id);
  const board = layout === "board";
  // An open task takes the page; the list stays behind it, laid out but
  // unseen, so going back finds it scrolled and folded as it was left.
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        inert={Boolean(id)}
        className={cn(
          "@container flex min-h-0 min-w-0 flex-1 flex-col",
          id && "invisible absolute inset-0",
        )}
      >
        <PageHeader
          title={
            <>
              {translateText("navigation:sections.tasks")}
              {loaded ? (
                <span className="font-normal text-muted-foreground tabular-nums">
                  {tasks.length}
                </span>
              ) : null}
            </>
          }
        >
          <Tabs
            value={layout}
            onValueChange={(value) =>
              setView({ taskLayout: value as typeof layout })
            }
          >
            <TabsList aria-label={translateText("layout.label")}>
              <TabsTrigger
                value="list"
                aria-label={translateText("layout.list")}
                title={translateText("layout.list")}
                className="px-2"
              >
                <ListIcon aria-hidden="true" />
              </TabsTrigger>
              <TabsTrigger
                value="board"
                aria-label={translateText("layout.board")}
                title={translateText("layout.board")}
                className="px-2"
              >
                <KanbanIcon aria-hidden="true" />
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </PageHeader>
        {/* The page's main until a task takes the page; the same element
            either way, so the list keeps its place behind the task. */}
        <section
          role={id ? undefined : "main"}
          id={id ? undefined : "main"}
          className={cn(
            "min-h-0 flex-1",
            board ? "overflow-hidden" : "overflow-y-auto",
          )}
        >
          {error ? (
            <div className="mx-auto max-w-md py-16">
              <LoadError
                what={translateText("navigation:sections.tasks")}
                error={error}
              />
            </div>
          ) : !loaded ? (
            <Loading rows={6} className="mx-auto max-w-content py-3" />
          ) : tasks.length === 0 ? (
            <div className="mx-auto max-w-md py-16">
              <Empty icon={ListChecksIcon} title={translateText("empty.title")}>
                {translateText("empty.description")}
              </Empty>
            </div>
          ) : board ? (
            <BoardView tasks={tasks} />
          ) : (
            <ListView tasks={tasks} selected={last} hidden={Boolean(id)} />
          )}
        </section>
      </div>
      {id ? (
        <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
          <TaskPage key={id} id={id} />
        </div>
      ) : null}
    </div>
  );
}
