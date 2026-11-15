import type { ListGrouping } from "./task-view";
import type { Task } from "@/queries/tasks";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { agentName, useAgentList } from "@/queries/agents";
import { ProgressBar, TaskLine } from "./task-bits";
import { ago, statuses } from "./task-format";
import { useTaskNav } from "./task-nav";
import { childrenOf, executorOf, planOf, progressOf } from "./task-plan";
import { StatusIcon } from "./task-status-icon";

// The list: the tasks as rows, grouped by the piece of work each belongs to. A group's head is the
// parent (its status, title, number, how many subtasks and how far along); its subtasks hang under
// it, indented, and fold away. Tasks that belong to nothing are a group of their own. Each row says
// what the task waits for or is stuck on, who executes it and when it last moved.

/** A row: the mark, the number, the title, the line, the executor, the time. */
function Row({
  task,
  all,
  depth,
  step,
  phone,
}: {
  task: Task;
  all: readonly Task[];
  depth: number;
  step?: number | undefined;
  phone: boolean;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const [, setNav] = useTaskNav();
  const { agents } = useAgentList();
  const executor = executorOf(task);
  const who =
    executor === null ? t("assignee.me") : agentName(agents, executor);
  return (
    <li data-task={task.number}>
      <button
        type="button"
        onClick={() => void setNav({ task: task.id })}
        style={{ paddingLeft: `${0.9 + depth * 1.5}rem` }}
        className={cn(
          "grid w-full items-center gap-x-2 border-b py-1.5 pr-4 text-left text-sm outline-none hover:bg-muted/50 focus-visible:bg-muted/60",
          phone
            ? "grid-cols-[1.1rem_2.6rem_minmax(0,1fr)]"
            : "grid-cols-[1.1rem_3rem_minmax(0,1fr)_minmax(0,11rem)_6rem_4.5rem]",
        )}
      >
        <StatusIcon status={task.status} className="size-3.5" />
        <span className="text-xs text-muted-foreground tabular-nums">
          #{task.number}
        </span>
        <span className="truncate">{task.title}</span>
        {phone ? (
          <span className="col-start-3 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <TaskLine task={task} all={all} step={step} />
            <span className="ml-auto shrink-0">{ago(task.updatedAt)}</span>
          </span>
        ) : (
          <>
            <TaskLine task={task} all={all} step={step} />
            <span className="truncate text-xs text-muted-foreground">
              {who}
            </span>
            <span className="text-right text-xs text-muted-foreground/80 tabular-nums">
              {ago(task.updatedAt)}
            </span>
          </>
        )}
      </button>
    </li>
  );
}

/** A parent and what is under it: its head, then its subtasks by step, a parent among them in turn. */
function ParentGroup({
  parent,
  tasks,
  all,
  depth,
  phone,
}: {
  parent: Task;
  tasks: readonly Task[];
  all: readonly Task[];
  depth: number;
  phone: boolean;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const [, setNav] = useTaskNav();
  const [open, setOpen] = useState(true);
  const progress = progressOf(parent, all);
  const siblings = childrenOf(parent.id, all);
  const plan = planOf(siblings);
  const shown = new Set(tasks.map((x) => x.id));
  const order = [...siblings]
    .filter((x) => shown.has(x.id))
    .sort(
      (a, b) =>
        plan.stepOf.get(a.id)! - plan.stepOf.get(b.id)! || a.number - b.number,
    );
  return (
    <li data-group={parent.number}>
      <div
        style={{ paddingLeft: `${0.9 + depth * 1.5}rem` }}
        className="flex items-center gap-2 border-b bg-sidebar py-1.5 pr-4 text-xs"
      >
        <button
          type="button"
          aria-expanded={open}
          aria-label={t(open ? "list.fold" : "list.unfold", {
            title: parent.title,
          })}
          onClick={() => setOpen((o) => !o)}
          className="-ml-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          {open ? (
            <CaretDownIcon aria-hidden="true" className="size-3" />
          ) : (
            <CaretRightIcon aria-hidden="true" className="size-3" />
          )}
        </button>
        <StatusIcon status={parent.status} className="size-3.5" />
        <button
          type="button"
          onClick={() => void setNav({ task: parent.id })}
          className="min-w-0 truncate text-[0.8125rem] outline-none hover:underline focus-visible:underline"
        >
          {parent.title}
        </button>
        <span className="shrink-0 text-muted-foreground tabular-nums" data-meta>
          {t("list.groupMeta", {
            number: parent.number,
            count: progress.total,
            done: progress.done,
            total: progress.total,
          })}
        </span>
        {progress.total > 0 && !phone ? (
          <ProgressBar progress={progress} className="ml-auto w-28 shrink-0" />
        ) : null}
      </div>
      {open ? (
        <ul>
          {order.map((child) =>
            childrenOf(child.id, all).length > 0 ? (
              <ParentGroup
                key={child.id}
                parent={child}
                tasks={tasks}
                all={all}
                depth={depth + 1}
                phone={phone}
              />
            ) : (
              <Row
                key={child.id}
                task={child}
                all={all}
                depth={depth + 1}
                step={plan.stepOf.get(child.id)}
                phone={phone}
              />
            ),
          )}
        </ul>
      ) : null}
    </li>
  );
}

/** A plain group: a head with its name and the rows under it. */
function Group({
  label,
  tasks,
  all,
  phone,
  icon,
}: {
  label: string;
  tasks: readonly Task[];
  all: readonly Task[];
  phone: boolean;
  icon?: React.ReactNode;
}) {
  if (tasks.length === 0) return null;
  return (
    <li data-group="">
      <div className="flex items-center gap-2 border-b bg-sidebar px-4 py-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
        <span className="tabular-nums">{tasks.length}</span>
      </div>
      <ul>
        {tasks.map((task) => (
          <Row key={task.id} task={task} all={all} depth={0} phone={phone} />
        ))}
      </ul>
    </li>
  );
}

export function ListView({
  tasks,
  all,
  grouping,
  phone,
}: {
  tasks: readonly Task[];
  all: readonly Task[];
  grouping: ListGrouping;
  phone: boolean;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const shown = new Set(tasks.map((x) => x.id));
  let body: React.ReactNode;
  if (grouping === "status")
    body = statuses.map((s) => (
      <Group
        key={s.value}
        label={s.label}
        icon={<StatusIcon status={s.value} className="size-3.5" />}
        tasks={tasks.filter((x) => x.status === s.value)}
        all={all}
        phone={phone}
      />
    ));
  else if (grouping === "none")
    body = (
      <li>
        <ul>
          {tasks.map((task) => (
            <Row key={task.id} task={task} all={all} depth={0} phone={phone} />
          ))}
        </ul>
      </li>
    );
  else {
    // The top of each piece of work that shows: a parent whose own parent is not shown.
    const tops = tasks.filter(
      (task) =>
        childrenOf(task.id, all).length > 0 &&
        (task.parentId == null || !shown.has(task.parentId)),
    );
    // A subtask whose parent is filtered out still shows, under its parent's head.
    const orphans = tasks.filter(
      (task) =>
        task.parentId != null &&
        !shown.has(task.parentId) &&
        childrenOf(task.id, all).length === 0,
    );
    const orphanParents = [...new Set(orphans.map((task) => task.parentId!))]
      .map((id) => all.find((x) => x.id === id))
      .filter((p): p is Task => p !== undefined && !tops.includes(p));
    const loose = tasks.filter(
      (task) => task.parentId == null && childrenOf(task.id, all).length === 0,
    );
    body = (
      <>
        {[...tops, ...orphanParents].map((parent) => (
          <ParentGroup
            key={parent.id}
            parent={parent}
            tasks={tasks}
            all={all}
            depth={0}
            phone={phone}
          />
        ))}
        <Group label={t("list.loose")} tasks={loose} all={all} phone={phone} />
      </>
    );
  }
  return (
    <div className="h-full overflow-y-auto">
      <ul aria-label={t("views.list")} className="pb-6">
        {body}
      </ul>
    </div>
  );
}
