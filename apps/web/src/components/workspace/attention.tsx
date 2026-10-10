import type { ReactNode } from "react";
import { BellIcon } from "@phosphor-icons/react/Bell";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { Link } from "@tanstack/react-router";
import { Empty, LoadError, Loading } from "@/components/states";
import { cn } from "@/lib/utils";
import { useRoutines } from "@/queries/routines";
import { useTasks } from "@/queries/tasks";
import { useAttention } from "./use-attention";

// Everything waiting for the user, the same in the side panel and on the
// full-window page: tasks and routines to open. Each row says what it is,
// why it waits and what to do.

const linkRow =
  "flex items-center gap-3 px-3 py-2.5 transition-colors duration-[60ms] ease-linear outline-none hover:bg-muted/60 focus-visible:bg-muted/60 motion-reduce:transition-none";

/** A task or routine's row: what it is and why it waits, then a caret. */
function LinkRowBody({
  icon: Icon,
  title,
  reason,
  alert,
}: {
  icon: typeof ClockIcon;
  title: ReactNode;
  reason: string;
  alert: boolean;
}) {
  return (
    <>
      <span className="flex size-7 shrink-0 items-center justify-center">
        <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-3 text-sm break-words">{title}</span>
        <span
          className={cn(
            "block text-xs",
            alert ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {reason}
        </span>
      </span>
      <CaretRightIcon
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground"
      />
    </>
  );
}

function Group({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  if (!count) return null;
  return (
    <section aria-label={label}>
      <h3 className="flex gap-1.5 px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground">
        {label}
        <span className="tabular-nums">{count}</span>
      </h3>
      <ul className="divide-y">{children}</ul>
    </section>
  );
}

/** Tasks and routines waiting for the user, by kind. */
export function PendingList() {
  // Only their state: the items come from useAttention.
  const sources = [
    { what: "任务", query: useTasks() },
    { what: "定时", query: useRoutines() },
  ];
  const { tasks, routines } = useAttention();
  const failed = sources.filter(({ query }) => query.error);
  const loading = sources.some(({ query }) => query.isPending);
  const total = tasks.length + routines.length;

  if (loading && !total) return <Loading rows={3} />;
  return (
    <div>
      {failed.length ? (
        <LoadError
          what={failed.map(({ what }) => what).join("、")}
          error={failed[0].query.error!}
          onRetry={() => failed.forEach(({ query }) => void query.refetch())}
          className="py-6"
        />
      ) : null}
      {!total && !failed.length && !loading ? (
        <Empty icon={BellIcon} title="没有等你处理的事">
          交给你的任务、新的定时报告，都会在这里。
        </Empty>
      ) : null}
      <Group label="任务" count={tasks.length}>
        {tasks.map(({ task, reason, alert }) => (
          <li key={task.id}>
            <Link
              to="/workspace/tasks"
              search={{ task: task.id }}
              title={`#${task.number} ${task.title}`}
              className={linkRow}
            >
              <LinkRowBody
                icon={ListChecksIcon}
                title={
                  <>
                    <span className="text-muted-foreground tabular-nums">
                      #{task.number}{" "}
                    </span>
                    {task.title}
                  </>
                }
                reason={reason}
                alert={alert}
              />
            </Link>
          </li>
        ))}
      </Group>
      <Group label="定时" count={routines.length}>
        {routines.map(({ routine, reason, alert }) => (
          <li key={routine.id}>
            <Link
              to="/workspace/routines"
              search={{ routine: routine.id }}
              title={routine.name}
              className={linkRow}
            >
              <LinkRowBody
                icon={ClockIcon}
                title={routine.name}
                reason={reason}
                alert={alert}
              />
            </Link>
          </li>
        ))}
      </Group>
    </div>
  );
}
