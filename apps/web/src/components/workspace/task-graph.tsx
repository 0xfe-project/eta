import type { TaskDependencyView } from "@eta/client-contracts";
import type { Task, TaskDetail } from "@/queries/tasks";
import { HourglassIcon } from "@phosphor-icons/react/Hourglass";
import { LinkBreakIcon } from "@phosphor-icons/react/LinkBreak";
import { XIcon } from "@phosphor-icons/react/X";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  useAddDependency,
  useRemoveDependency,
  useUpdateTask,
} from "@/queries/tasks";
import { wireErrorMessage } from "@/queries/wire";
import { numbersLabel } from "./task-format";
import { useTaskNav } from "./task-nav";
import { StatusIcon } from "./task-status-icon";

// What a task waits for and what waits for it, as the host's graph says (`dependsOn`,
// `dependents`); the rules are the host's, these only show them and send the user's changes.

const showError = (error: Error) => toast.error(wireErrorMessage(error));

/** The edges of a task that are not resolved: waiting, or cancelled. */
const open = (task: Pick<Task, "dependsOn">) => {
  const edges = task.dependsOn ?? [];
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

/**
 * The way out of a block a cancelled dependency made: stop waiting for it, or cancel this task.
 * Shown on a blocked card whose task waits for something cancelled; the host undoes its own block
 * once nothing it waits for is cancelled.
 */
export function BlockedExits({ task }: { task: Task }) {
  const { t } = useTranslation(["tasks"] as const);
  const remove = useRemoveDependency();
  const update = useUpdateTask();
  const { cancelled } = open(task);
  if (task.status !== "blocked" || cancelled.length === 0) return null;
  const busy = remove.isPending || update.isPending;
  return (
    <div
      role="group"
      aria-label={t("graph.blockedHint")}
      className="flex flex-wrap gap-1 border-x border-b bg-card px-2 pb-2"
    >
      {cancelled.map((edge) => (
        <Button
          key={edge.taskId}
          variant="outline"
          size="xs"
          disabled={busy}
          onClick={() =>
            remove.mutate(
              { taskId: task.id, dependsOn: edge.taskId },
              { onError: showError },
            )
          }
        >
          <LinkBreakIcon aria-hidden="true" />
          {t("graph.removeShort", { number: edge.number })}
        </Button>
      ))}
      <Button
        variant="ghost"
        size="xs"
        disabled={busy}
        onClick={() =>
          update.mutate(
            { taskId: task.id, status: "cancelled" },
            { onError: showError },
          )
        }
      >
        <XIcon aria-hidden="true" />
        {t("graph.cancelTask")}
      </Button>
    </div>
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

/** A field to name one more task this one waits for, `#12` or `12`, with "must be done". */
function AddDependency({ task }: { task: TaskDetail }) {
  const { t } = useTranslation(["tasks"] as const);
  const add = useAddDependency();
  const [which, setWhich] = useState("");
  const [requireDone, setRequireDone] = useState(false);
  const submit = () => {
    const dependsOn = which.trim();
    if (dependsOn === "") return;
    add.mutate(
      { taskId: task.id, dependsOn, requireDone },
      {
        onError: showError,
        onSuccess: () => {
          setWhich("");
          setRequireDone(false);
        },
      },
    );
  };
  return (
    <form
      className="flex items-center gap-1.5 pt-1"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Input
        aria-label={t("graph.add")}
        placeholder={t("graph.addPlaceholder")}
        value={which}
        onChange={(e) => setWhich(e.target.value)}
        className="h-7 w-20 text-xs"
      />
      <label
        className="flex shrink-0 items-center gap-1 text-xs whitespace-nowrap text-muted-foreground"
        title={t("graph.requireDoneHint")}
      >
        <Checkbox
          checked={requireDone}
          onCheckedChange={(checked) => setRequireDone(checked === true)}
        />
        {t("graph.requireDone")}
      </label>
      <Button
        type="submit"
        variant="ghost"
        size="xs"
        disabled={add.isPending || which.trim() === ""}
      >
        {t("graph.add")}
      </Button>
    </form>
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
      <dt className={labelClassName}>{t("graph.dependsOn")}</dt>
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
          <dt className={labelClassName}>{t("graph.dependents")}</dt>
          <dd className="min-w-0 py-1">
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
