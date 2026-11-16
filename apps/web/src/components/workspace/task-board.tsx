import type { ListGrouping } from "./task-view";
import type { Task } from "@/queries/tasks";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { SidebarSimpleIcon } from "@phosphor-icons/react/SidebarSimple";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Empty, LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { useAgentList } from "@/queries/agents";
import {
  useAllTasks,
  useArchivedTasks,
  useTask,
  useTasks,
} from "@/queries/tasks";
import { PageHeader } from "./app-shell";
import { BackToTop } from "./back-to-top";
import { when } from "./routine-format";
import {
  ArchivedBanner,
  ArchiveDialog,
  ArchivedMatches,
  ArchivedToggle,
  ArchivedView,
} from "./task-archive";
import { BoardView } from "./task-board-view";
import {
  BlockedBanner,
  FlowBar,
  JoinBaseHint,
  ProgressCard,
  QueueReason,
  SubtaskList,
} from "./task-detail";
import { canCancelTree, createdBy } from "./task-format";
import { ListView } from "./task-list-view";
import { useTaskNav } from "./task-nav";
import { NewTaskDialog } from "./task-new";
import { childrenOf, filterTasks, planOf, stepsLeft } from "./task-plan";
import { PlanGroup, PlanView } from "./task-plan-view";
import { StatusIcon } from "./task-status-icon";
import { CancelTreeDialog } from "./task-status-select";
import {
  ClearFilter,
  ExecutorFilter,
  NewTask,
  ParentFilter,
  TaskSearch,
  ViewSwitch,
} from "./task-toolbar";
import { listGroupings, useTaskView } from "./task-view";
import {
  CommentBox,
  DeleteTaskDialog,
  Description,
  EditableTitle,
  LiveRuns,
  Question,
  TaskMissing,
  TaskProperties,
  Timeline,
} from "./tasks";
import { useArchiveAction } from "./use-archive-action";

// The tasks page: every task as a board to drag across the statuses, a list grouped by the piece
// of work each belongs to, or a plan of the steps the work falls into; or one open task in its
// place. The three views share one bar and one filter. The task lays itself out by its own width
// (container queries), not the window's.

// --- task ---------------------------------------------------------------------------

// The properties rail sits beside the document from `@4xl` up: wide enough for the document
// (~680px) and the properties (~280px) side by side. The variant is spelled out in each class
// rather than built from a constant: Tailwind only generates classes it finds written whole in the
// source, and an interpolated one rendered only while some test happened to spell it out.

/**
 * One task as a document: the number, title, description and activity in a
 * centered column, the properties always in a rail beside it. Narrower than
 * that, the rail is out of the way and a button in the header opens it.
 * The side panel (`TaskView`) is a different layout and is not this.
 */
function TaskPage({ id }: { id: string }) {
  const { t: translateText } = useTranslation([
    "tasks",
    "common",
    "navigation",
  ] as const);
  const [, setNav] = useTaskNav();
  const { task, missing, error } = useTask(id);
  const { agents } = useAgentList();
  const [deleting, setDeleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // Opened from the header, only while the rail does not fit.
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  // Archived ones too: a subtask, a parent or a dependency put away is still part of this one.
  const { tasks: all } = useAllTasks();
  const archive = useArchiveAction(task, all);
  const phone = useIsMobile();
  // A piece of work opens on its plan; its overview is the page every task has.
  const [mode, setMode] = useState<"overview" | "plan">("plan");
  const back = () => void setNav({ task: null });
  // The list goes inert as the task opens; take focus so it doesn't fall to
  // <body>. Each branch below has its own <main>, so again once loaded.
  const mainRef = useRef<HTMLElement>(null);
  const loaded = Boolean(task);
  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
  }, [loaded]);
  const crumbs = (
    <button
      type="button"
      onClick={back}
      className="flex min-w-0 items-center gap-1.5 text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
    >
      <ArrowLeftIcon aria-hidden="true" className="size-3.5 shrink-0" />
      {task?.ancestors?.at(-1) === undefined ? null : (
        <span className="max-w-[40%] shrink-0 truncate">
          {task.ancestors.at(-1)!.title} ›
        </span>
      )}
      <span className="truncate text-foreground">
        {task ? task.title : translateText("navigation:sections.tasks")}
      </span>
    </button>
  );
  if (!task)
    return (
      <>
        <PageHeader title={crumbs} />
        <main
          ref={mainRef}
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-[42.5rem] px-4 py-6 outline-none sm:px-8"
        >
          <TaskMissing missing={missing} error={error} />
        </main>
      </>
    );
  const propertiesLabel = translateText("details.propertiesTab");
  const children = childrenOf(task.id, all);
  const isParent = children.length > 0;
  // The list's copy of the task: what the board's helpers read.
  const listed = all.find((x) => x.id === task.id) ?? task;
  const showPlan = isParent && mode === "plan";
  return (
    <>
      <PageHeader title={crumbs}>
        {isParent ? (
          <ViewSwitch
            value={mode}
            options={["overview", "plan"]}
            onChange={(v) => setMode(v as "overview" | "plan")}
          />
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={propertiesLabel}
          aria-expanded={propertiesOpen}
          aria-controls="task-properties"
          title={propertiesLabel}
          className={cn("@4xl:hidden", showPlan && "hidden")}
          onClick={() => setPropertiesOpen((open) => !open)}
        >
          <SidebarSimpleIcon aria-hidden="true" />
        </Button>
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
            {canCancelTree(task) ? (
              <DropdownMenuItem onSelect={() => setCancelling(true)}>
                {translateText("statusMenu.cancelTree")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={archive.run}>
              {archive.label}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setDeleting(true)}
            >
              {translateText("common:actions.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <ArchiveDialog action={archive} />
        <CancelTreeDialog
          task={task}
          open={cancelling}
          onOpenChange={setCancelling}
        />
        <DeleteTaskDialog
          task={task}
          open={deleting}
          onOpenChange={setDeleting}
          onDeleted={back}
        />
      </PageHeader>
      {showPlan ? (
        <main
          ref={mainRef}
          id="main"
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4 outline-none sm:px-6"
        >
          <ArchivedBanner task={task} className="mb-3" />
          <p className="mb-3 text-xs text-muted-foreground tabular-nums">
            {`#${task.number} · `}
            {stepsLeft(
              planOf(children.filter((c) => c.status !== "cancelled")),
            ) === 0
              ? translateText("plan.allDone")
              : translateText("plan.left", {
                  count: stepsLeft(
                    planOf(children.filter((c) => c.status !== "cancelled")),
                  ),
                })}
          </p>
          <PlanGroup
            parent={listed}
            tasks={children.filter((c) => c.status !== "cancelled")}
            all={all}
            phone={phone}
            head={false}
          />
        </main>
      ) : (
        <main
          ref={mainRef}
          id="main"
          tabIndex={-1}
          className="grid min-h-0 w-full flex-1 grid-cols-1 overflow-hidden outline-none @4xl:grid-cols-[minmax(0,1fr)_17.5rem]"
        >
          <div className="min-h-0 overflow-y-auto">
            <div className="mx-auto w-full max-w-[42.5rem] space-y-6 px-4 pt-4 pb-6 sm:px-8">
              <ArchivedBanner task={task} />
              <p className="text-xs text-muted-foreground tabular-nums">
                <span>#{task.number}</span>
                {isParent ? ` · ${translateText("detail.parent")}` : null}
                {" · "}
                {createdBy(task, agents)}
              </p>
              <div className="flex items-start gap-2.5">
                <StatusIcon
                  status={task.status}
                  className="mt-1.5 size-5 shrink-0"
                />
                <EditableTitle task={task} className="min-w-0 flex-1 text-xl" />
              </div>
              <BlockedBanner task={task} all={all} />
              {isParent ? (
                <>
                  <ProgressCard task={listed} all={all} />
                  <SubtaskList task={listed} all={all} />
                </>
              ) : (
                <>
                  <FlowBar task={task} phone={phone} />
                  <JoinBaseHint task={task} />
                  <QueueReason task={task} all={all} />
                </>
              )}
              <Question task={task} />
              <Description key={task.description} task={task} className="" />
              <section aria-labelledby="task-activity" className="space-y-3">
                <h2 id="task-activity" className="text-sm font-semibold">
                  {translateText("details.activityTab")}
                </h2>
                <Timeline task={task} />
                <CommentBox
                  task={task}
                  className="sticky bottom-0 z-10 -mx-4 bg-background px-4 pt-2 pb-4 sm:-mx-8 sm:px-8"
                  top={<LiveRuns task={task} className="space-y-1 pb-1.5" />}
                />
              </section>
            </div>
            <BackToTop className="mx-auto max-w-[42.5rem] px-4 sm:px-8" />
          </div>
          {propertiesOpen ? (
            <button
              type="button"
              aria-label={propertiesLabel}
              className="fixed inset-0 z-20 bg-black/20 @4xl:hidden"
              onClick={() => setPropertiesOpen(false)}
            />
          ) : null}
          <aside
            id="task-properties"
            aria-label={propertiesLabel}
            // Narrow: `hidden` takes it out of the one-column grid until the
            // header opens it over the document. Wide (`@4xl`): `@4xl:block`
            // wins over that, so the rail stays in the second column.
            className={cn(
              "overflow-y-auto border-l bg-background px-4 py-5 text-xs",
              "@4xl:static @4xl:z-auto @4xl:block @4xl:w-auto @4xl:shadow-none",
              propertiesOpen
                ? "fixed top-12 right-0 bottom-0 z-30 block w-[17.5rem] shadow-md"
                : "hidden",
            )}
          >
            <TaskProperties task={task} page>
              <dt className="text-xs leading-8 text-muted-foreground">
                {translateText("fields.updatedAt")}
              </dt>
              <dd className="leading-8 tabular-nums">{when(task.updatedAt)}</dd>
            </TaskProperties>
          </aside>
        </main>
      )}
    </>
  );
}

// --- page ---------------------------------------------------------------------------

/** The bar's filters: in the header on a wide page, a row of their own under it on a phone. */
function Filters({ tasks }: { tasks: readonly Task[] }) {
  return (
    <>
      <TaskSearch />
      <ExecutorFilter tasks={tasks} />
      <ParentFilter tasks={tasks} />
      <ClearFilter />
      <ArchivedToggle />
    </>
  );
}

/** The list's grouping: by the piece of work, by status, or none. */
function GroupingMenu() {
  const { t } = useTranslation(["tasks"] as const);
  const grouping = useTaskView((s) => s.grouping);
  const setGrouping = useTaskView((s) => s.setGrouping);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs font-normal text-muted-foreground"
        >
          {t("list.grouping", { name: t(`list.groupBy.${grouping}`) })}
          <CaretDownIcon aria-hidden="true" className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={grouping}
          onValueChange={(v) => setGrouping(v as ListGrouping)}
        >
          {listGroupings.map((g) => (
            <DropdownMenuRadioItem key={g} value={g}>
              {t(`list.groupBy.${g}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TaskBoard() {
  const { t: translateText } = useTranslation([
    "tasks",
    "common",
    "navigation",
  ] as const);
  const [nav] = useTaskNav();
  const { tasks, loaded, error } = useTasks();
  const archived = useArchivedTasks();
  // The done column says how many more of its kind are put away.
  const archivedDone = archived.filter((t) => t.status === "done").length;
  const showArchived = nav.archived === true;
  const view = useTaskView((s) => s.view);
  const setView = useTaskView((s) => s.setView);
  const grouping = useTaskView((s) => s.grouping);
  const filter = useTaskView((s) => s.filter);
  const phone = useIsMobile();
  const shown = useMemo(() => filterTasks(tasks, filter), [tasks, filter]);
  const filtered = shown.length !== tasks.length;
  const id = nav.task ?? null;
  // An open task takes the page; the board stays behind it, laid out but
  // unseen, so going back finds it scrolled as it was left.
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
                  {filtered
                    ? `${shown.length} / ${tasks.length}`
                    : tasks.length}
                </span>
              ) : null}
            </>
          }
        >
          {phone ? null : showArchived ? (
            <ArchivedToggle />
          ) : (
            <Filters tasks={tasks} />
          )}
          {view === "list" && !phone && !showArchived ? <GroupingMenu /> : null}
          {showArchived ? null : <ViewSwitch value={view} onChange={setView} />}
          <NewTask />
        </PageHeader>
        {phone && !showArchived ? (
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1">
            <Filters tasks={tasks} />
          </div>
        ) : null}
        {/* The page's main until a task takes the page; the same element
            either way, so the board keeps its place behind the task. */}
        <section
          role={id ? undefined : "main"}
          id={id ? undefined : "main"}
          data-view={showArchived ? "archived" : view}
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          {showArchived ? (
            <ArchivedView />
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-hidden">
                {error ? (
                  <div className="mx-auto max-w-md py-16">
                    <LoadError
                      what={translateText("navigation:sections.tasks")}
                      error={error}
                    />
                  </div>
                ) : !loaded ? (
                  <Loading rows={6} className="mx-auto max-w-content py-3" />
                ) : tasks.length === 0 && filter.q.trim() === "" ? (
                  <div className="mx-auto max-w-md py-16">
                    <Empty
                      icon={ListChecksIcon}
                      title={translateText("empty.title")}
                    >
                      {translateText("empty.description")}
                    </Empty>
                  </div>
                ) : shown.length === 0 ? (
                  <div className="mx-auto max-w-md py-16">
                    <Empty
                      icon={ListChecksIcon}
                      title={translateText("views.noMatch")}
                    />
                  </div>
                ) : view === "list" ? (
                  <ListView
                    tasks={shown}
                    all={tasks}
                    grouping={grouping}
                    phone={phone}
                  />
                ) : view === "plan" ? (
                  <PlanView tasks={shown} all={tasks} phone={phone} />
                ) : (
                  <BoardView
                    tasks={shown}
                    all={tasks}
                    phone={phone}
                    archivedDone={filtered ? 0 : archivedDone}
                  />
                )}
              </div>
              <ArchivedMatches q={filter.q} onBoard={shown.length} />
            </>
          )}
        </section>
      </div>
      {id ? (
        <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
          <TaskPage key={id} id={id} />
        </div>
      ) : null}
      <NewTaskDialog />
    </div>
  );
}
