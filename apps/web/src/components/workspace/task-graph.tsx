import type { TaskDependencyView, TaskRefView } from "@eta/client-contracts";
import type { Task, TaskDetail } from "@/queries/tasks";
import { HourglassIcon } from "@phosphor-icons/react/Hourglass";
import { LinkBreakIcon } from "@phosphor-icons/react/LinkBreak";
import { TreeStructureIcon } from "@phosphor-icons/react/TreeStructure";
import { XIcon } from "@phosphor-icons/react/X";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
  useAddDependency,
  useRemoveDependency,
  useSetParent,
  useTasks,
} from "@/queries/tasks";
import { wireErrorMessage } from "@/queries/wire";
import { numbersLabel } from "./task-format";
import { useTaskNav } from "./task-nav";
import { TaskPicker } from "./task-picker";
import { stepAmongSiblings } from "./task-plan";
import { StatusIcon } from "./task-status-icon";

// What a task waits for and what waits for it, as the host's graph says (`dependsOn`,
// `dependents`); the rules are the host's, these only show them and send the user's changes.

const showError = (error: Error) => toast.error(wireErrorMessage(error));

/**
 * What a task's work still waits for, its parents' edges included: waiting, or cancelled. A host
 * that sends no `waitingOn` (older than subtasks) has the task's own edges only.
 */
const open = (task: Pick<Task, "dependsOn" | "waitingOn">) => {
  const edges =
    task.waitingOn ??
    (task.dependsOn ?? [])
      .filter((edge) => edge.state !== "resolved")
      .map((edge) => ({ ...edge, via: null }));
  return {
    waiting: edges.filter((edge) => edge.state === "waiting"),
    cancelled: edges.filter((edge) => edge.state === "cancelled"),
  };
};

/**
 * "Waiting for #12, #13" on a card or a row, and the cancelled ones in red. Nothing when the
 * task waits for nothing, or has started its work (what it waited for no longer matters then).
 */
export function DependencyBadge({
  task,
  className,
}: {
  task: Task;
  className?: string;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const { waiting, cancelled } = open(task);
  const started =
    task.status === "in_progress" ||
    task.status === "in_review" ||
    task.status === "done" ||
    task.status === "cancelled";
  if (started || (waiting.length === 0 && cancelled.length === 0)) return null;
  return (
    <span
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs",
        className,
      )}
    >
      {cancelled.length > 0 ? (
        <span className="inline-flex min-w-0 items-center gap-1 text-destructive">
          <LinkBreakIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">
            {t("graph.cancelledDependency", {
              tasks: numbersLabel(cancelled.map((edge) => edge.number)),
            })}
          </span>
        </span>
      ) : null}
      {waiting.length > 0 ? (
        <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
          <HourglassIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">
            {t("graph.waitingOn", {
              tasks: numbersLabel(waiting.map((edge) => edge.number)),
            })}
          </span>
        </span>
      ) : null}
    </span>
  );
}

/** One edge: the other task, where the edge stands, and (for what it waits for) its controls. */
function Edge({
  task,
  edge,
  editable,
}: {
  task: TaskDetail;
  edge: TaskDependencyView;
  editable: boolean;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const [, setNav] = useTaskNav();
  const add = useAddDependency();
  const remove = useRemoveDependency();
  return (
    // The number and the title always show: the title wraps rather than truncating, and the
    // controls move under it when the column is too narrow for both.
    <li className="flex min-w-0 flex-wrap items-start gap-x-1.5 text-xs leading-6">
      <StatusIcon status={edge.status} className="mt-1.25 size-3.5 shrink-0" />
      <button
        type="button"
        onClick={() => void setNav({ task: edge.taskId })}
        className="min-w-0 flex-1 basis-32 text-left wrap-anywhere hover:underline"
      >
        <span className="whitespace-nowrap text-muted-foreground tabular-nums">
          #{edge.number}
        </span>{" "}
        {edge.title}
      </button>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <span
          className={cn(
            "shrink-0",
            edge.state === "cancelled"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {t(`graph.state.${edge.state}`)}
        </span>
        {editable ? (
          <>
            <label
              className="flex shrink-0 items-center gap-1 whitespace-nowrap text-muted-foreground"
              title={t("graph.requireDoneHint")}
            >
              <Checkbox
                checked={edge.requireDone}
                disabled={add.isPending}
                onCheckedChange={(checked) =>
                  add.mutate(
                    {
                      taskId: task.id,
                      dependsOn: edge.taskId,
                      requireDone: checked === true,
                    },
                    { onError: showError },
                  )
                }
              />
              {t("graph.requireDone")}
            </label>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("graph.remove", { number: edge.number })}
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(
                  { taskId: task.id, dependsOn: edge.taskId },
                  { onError: showError },
                )
              }
            >
              <XIcon aria-hidden="true" />
            </Button>
          </>
        ) : null}
      </span>
    </li>
  );
}

/** "Edit…": the picker, to add one more task this one waits for. */
function AddDependency({ task }: { task: TaskDetail }) {
  const { t } = useTranslation(["tasks"] as const);
  const add = useAddDependency();
  const own = (task.dependsOn ?? []).map((edge) => edge.taskId);
  return (
    <TaskPicker
      mode="dependsOn"
      subject={{ id: task.id, parentId: task.parentId ?? null }}
      projectId={task.projectId ?? undefined}
      exclude={own}
      onPick={(other, requireDone) =>
        add.mutate(
          { taskId: task.id, dependsOn: other.id, requireDone },
          { onError: showError },
        )
      }
    >
      <Button
        variant="ghost"
        size="xs"
        className="-ml-2 text-muted-foreground"
        disabled={add.isPending}
      >
        {t("rail.edit")}
      </Button>
    </TaskPicker>
  );
}

/** The two property rows: what the task waits for (editable), and what waits for it. */
export function DependencyRows({
  task,
  labelClassName,
}: {
  task: TaskDetail;
  labelClassName: string;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const dependsOn = task.dependsOn ?? [];
  const dependents = task.dependents ?? [];
  return (
    <>
      <dt className={labelClassName}>{t("create.dependsOn")}</dt>
      <dd className="min-w-0 py-1">
        {dependsOn.length > 0 ? (
          <ul aria-label={t("graph.dependsOn")}>
            {dependsOn.map((edge) => (
              <Edge key={edge.taskId} task={task} edge={edge} editable />
            ))}
          </ul>
        ) : null}
        {task.status === "blocked" &&
        dependsOn.some((edge) => edge.state === "cancelled") ? (
          <p className="text-xs leading-5 text-destructive">
            {t("graph.blockedHint")}
          </p>
        ) : null}
        <AddDependency task={task} />
      </dd>
      {dependents.length > 0 ? (
        <>
          <dt className={labelClassName}>{t("rail.dependents")}</dt>
          <dd className="min-w-0 py-1">
            <p className="text-xs leading-6 text-muted-foreground">
              {t(
                task.subtasks == null
                  ? "rail.dependentsCount"
                  : "rail.dependentsAll",
                {
                  count: dependents.length,
                },
              )}
            </p>
            <ul aria-label={t("graph.dependents")}>
              {dependents.map((edge) => (
                <Edge
                  key={edge.taskId}
                  task={task}
                  edge={edge}
                  editable={false}
                />
              ))}
            </ul>
          </dd>
        </>
      ) : null}
    </>
  );
}

/** A task named by its number and title, which opens it. */
function TaskLink({ task }: { task: TaskRefView }) {
  const [, setNav] = useTaskNav();
  return (
    <button
      type="button"
      onClick={() => void setNav({ task: task.taskId })}
      className="min-w-0 truncate text-left hover:underline"
    >
      <span className="text-muted-foreground tabular-nums">#{task.number}</span>{" "}
      {task.title}
    </button>
  );
}

/** The way to put the task under a piece of work (the picker), or to take it out of one. */
function ParentField({ task }: { task: TaskDetail }) {
  const { t } = useTranslation(["tasks"] as const);
  const set = useSetParent();
  const parent = task.ancestors?.at(-1);
  if (parent !== undefined)
    return (
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t("rail.removeParent")}
        disabled={set.isPending}
        onClick={() =>
          set.mutate({ taskId: task.id, parent: null }, { onError: showError })
        }
      >
        <XIcon aria-hidden="true" />
      </Button>
    );
  return (
    <TaskPicker
      mode="parent"
      subject={{ id: task.id, parentId: null }}
      projectId={task.projectId ?? undefined}
      onPick={(other) =>
        set.mutate(
          { taskId: task.id, parent: other.id },
          { onError: showError },
        )
      }
    >
      <Button
        variant="ghost"
        size="xs"
        className="-ml-2 text-muted-foreground"
        disabled={set.isPending}
      >
        {t("create.pickParent")}
      </Button>
    </TaskPicker>
  );
}

/**
 * The two rows of the tree on a task's page: where it sits (its parents, the top first, as a
 * breadcrumb) and its subtasks, whose statuses its own comes from.
 */
export function TreeRows({
  task,
  labelClassName,
  withChildren = true,
}: {
  task: TaskDetail;
  labelClassName: string;
  /** The subtasks too; the page lists them in its document instead. */
  withChildren?: boolean;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const { tasks: all } = useTasks();
  const ancestors = task.ancestors ?? [];
  const children = withChildren ? (task.children ?? []) : [];
  const listed = all.find((x) => x.id === task.id);
  const step =
    listed === undefined ? undefined : stepAmongSiblings(listed, all);
  return (
    <>
      <dt className={labelClassName}>{t("rail.belongsTo")}</dt>
      <dd className="flex min-w-0 items-center gap-1 py-1 text-xs leading-6">
        {ancestors.length > 0 ? (
          <nav
            aria-label={t("graph.parent")}
            className="flex min-w-0 flex-1 items-center gap-1"
          >
            {ancestors.map((ancestor, i) => (
              <span
                key={ancestor.taskId}
                className="flex min-w-0 items-center gap-1"
              >
                {i > 0 ? (
                  <span aria-hidden="true" className="text-muted-foreground">
                    ›
                  </span>
                ) : null}
                <TaskLink task={ancestor} />
              </span>
            ))}
            {step === undefined ? null : (
              <span className="shrink-0 text-muted-foreground">
                · {t("cards.step", { count: step })}
              </span>
            )}
          </nav>
        ) : null}
        <ParentField task={task} />
      </dd>
      {children.length > 0 ? (
        <>
          <dt className={labelClassName}>{t("graph.children")}</dt>
          <dd className="min-w-0 py-1">
            <ul aria-label={t("graph.children")}>
              {children.map((child) => (
                <li
                  key={child.taskId}
                  className="flex min-w-0 items-center gap-1.5 text-xs leading-6"
                >
                  <StatusIcon
                    status={child.status}
                    className="size-3.5 shrink-0"
                  />
                  <TaskLink task={child} />
                </li>
              ))}
            </ul>
          </dd>
        </>
      ) : null}
    </>
  );
}

/** "Subtasks 3/5", the cancelled ones not counted; nothing for a task without subtasks. */
export function SubtaskCount({ task }: { task: Task }) {
  const { t } = useTranslation(["tasks"] as const);
  if (task.subtasks == null) return null;
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      <TreeStructureIcon aria-hidden="true" className="size-3.5" />
      {t("graph.subtasks", {
        done: task.subtasks.done,
        total: task.subtasks.total,
      })}
    </span>
  );
}
