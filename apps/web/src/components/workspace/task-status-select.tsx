import type { TaskDetail, TaskStatus } from "@/queries/tasks";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useUpdateTask } from "@/queries/tasks";
import { wireErrorMessage } from "@/queries/wire";
import { blockedByCancel, statusLabel, statusTone } from "./task-format";
import { StatusIcon, StatusPill } from "./task-status-icon";

// Where a task's status is changed: a label in its status's colour that opens the seven, each with
// what it means and its key. A parent's status is its subtasks', so it has a label and no menu.

/** The menu's order and keys: the way through the work, then the two ways out of it. */
const groups: TaskStatus[][] = [
  ["backlog", "todo", "in_progress", "in_review", "done"],
  ["blocked", "cancelled"],
];
const order = groups.flat();

function hint(status: TaskStatus, dependents: number): string {
  switch (status) {
    case "backlog":
      return translate("tasks:statusMenu.hint.backlog");
    case "todo":
      return translate("tasks:statusMenu.hint.todo");
    case "in_progress":
      return translate("tasks:statusMenu.hint.inProgress");
    case "in_review":
      return translate("tasks:statusMenu.hint.inReview");
    case "done":
      return translate("tasks:statusMenu.hint.done");
    case "blocked":
      return translate("tasks:statusMenu.hint.blocked");
    case "cancelled":
      return dependents > 0
        ? translate("tasks:statusMenu.hint.cancelledDependents", {
            count: dependents,
          })
        : translate("tasks:statusMenu.hint.cancelled");
  }
}

/** The menu: the current status as its own label, and the seven to move to, keyed 1–7. */
function StatusSelect({
  value,
  onChange,
  dependents = 0,
  className,
}: {
  value: TaskStatus;
  onChange: (status: TaskStatus) => void;
  /** How many tasks a cancel would block, for "Cancelled"'s line. */
  dependents?: number;
  className?: string;
}) {
  const { t: translateText } = useTranslation(["tasks"] as const);
  const [open, setOpen] = useState(false);
  const tone = statusTone(value);
  const choose = (status: TaskStatus) => {
    setOpen(false);
    if (status !== value) onChange(status);
  };
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        aria-label={`${translateText("fields.status")}: ${statusLabel(value)}`}
        data-status={value}
        className={cn(
          "inline-flex h-7 min-w-32 items-center gap-1.5 border px-2 text-xs whitespace-nowrap outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
          tone.border,
          tone.tint,
          tone.text,
          className,
        )}
      >
        <StatusIcon status={value} className="size-3.5" />
        {statusLabel(value)}
        <CaretDownIcon aria-hidden="true" className="ml-auto size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-72"
        onKeyDown={(event) => {
          if (event.metaKey || event.ctrlKey || event.altKey) return;
          const status = order[Number(event.key) - 1];
          if (!/^[1-7]$/.test(event.key) || status === undefined) return;
          // Before the menu's own type-ahead, which would look for an item starting with the digit.
          event.preventDefault();
          event.stopPropagation();
          choose(status);
        }}
      >
        <DropdownMenuLabel className="pb-1">
          {translateText("statusMenu.title")}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(status) => choose(status as TaskStatus)}
        >
          {groups.map((group, index) => (
            <Fragment key={group[0]}>
              {index > 0 ? (
                <DropdownMenuSeparator className="mx-0 my-1" />
              ) : null}
              {group.map((status) => (
                <DropdownMenuPrimitive.RadioItem
                  key={status}
                  value={status}
                  aria-keyshortcuts={String(order.indexOf(status) + 1)}
                  className="grid cursor-default grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 px-3 py-1.5 text-xs outline-hidden select-none focus:bg-accent data-[state=checked]:bg-muted"
                >
                  <StatusIcon status={status} className="size-3.5" />
                  <span>{statusLabel(status)}</span>
                  {status === value ? (
                    <CheckIcon aria-hidden="true" className="size-3.5" />
                  ) : (
                    <kbd className="border px-1 font-sans text-[11px] leading-4 text-muted-foreground">
                      {order.indexOf(status) + 1}
                    </kbd>
                  )}
                  <span className="col-start-2 col-end-4 text-[11px] leading-4 text-muted-foreground">
                    {hint(status, dependents)}
                  </span>
                </DropdownMenuPrimitive.RadioItem>
              ))}
            </Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A task's status where it can be changed. A parent's comes from its subtasks, so it is a label,
 * with "Auto" beside it saying from how many.
 */
export function TaskStatusControl({
  task,
  className,
}: {
  task: TaskDetail;
  className?: string;
}) {
  const { t: translateText } = useTranslation(["tasks"] as const);
  const update = useUpdateTask();
  if (task.subtasks != null) {
    const count = task.children?.length ?? task.subtasks.total;
    const why = translateText("statusMenu.autoHint", { count });
    return (
      <span className={cn("inline-flex items-center gap-2", className)}>
        <StatusPill status={task.status} className="py-1" />
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                aria-description={why}
                className="text-xs text-muted-foreground outline-none focus-visible:underline"
              >
                {translateText("statusMenu.auto")}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{why}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </span>
    );
  }
  return (
    <StatusSelect
      className={className}
      value={task.status}
      dependents={blockedByCancel(task)}
      onChange={(status) =>
        update.mutate(
          { taskId: task.id, status },
          { onError: (error) => toast.error(wireErrorMessage(error)) },
        )
      }
    />
  );
}
