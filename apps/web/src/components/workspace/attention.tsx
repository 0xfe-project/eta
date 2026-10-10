import { ClockIcon } from "@phosphor-icons/react/Clock";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { Link } from "@tanstack/react-router";
import { useAttention } from "./use-attention";

const row =
  "flex items-center gap-2 px-2 py-1.5 text-sm transition-colors duration-[60ms] ease-linear outline-none hover:bg-muted/60 focus-visible:bg-muted/60";

/** Tasks and routines waiting for the user; confirmations are listed apart. */
export function AttentionList() {
  const { tasks, routines } = useAttention();
  if (!tasks.length && !routines.length) return null;
  return (
    <ul aria-label="其他待处理" className="divide-y border">
      {tasks.map(({ task, reason }) => (
        <li key={task.id}>
          <Link
            to="/workspace/tasks"
            search={{ task: task.id }}
            className={row}
          >
            <ListChecksIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 flex-1 truncate">
              <span className="text-muted-foreground tabular-nums">
                #{task.number}{" "}
              </span>
              {task.title}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {reason}
            </span>
          </Link>
        </li>
      ))}
      {routines.map(({ routine, reason }) => (
        <li key={routine.id}>
          <Link
            to="/workspace/routines"
            search={{ routine: routine.id }}
            className={row}
          >
            <ClockIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 flex-1 truncate">{routine.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {reason}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
