import type { TaskStatus } from "@/queries/tasks";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleIcon } from "@phosphor-icons/react/Circle";
import { CircleDashedIcon } from "@phosphor-icons/react/CircleDashed";
import { CircleHalfIcon } from "@phosphor-icons/react/CircleHalf";
import { EyeIcon } from "@phosphor-icons/react/Eye";
import { ProhibitIcon } from "@phosphor-icons/react/Prohibit";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { cn } from "@/lib/utils";

const statusIcons = {
  backlog: CircleDashedIcon,
  todo: CircleIcon,
  in_progress: CircleHalfIcon,
  in_review: EyeIcon,
  done: CheckCircleIcon,
  blocked: ProhibitIcon,
  cancelled: XCircleIcon,
} satisfies Record<TaskStatus, unknown>;

export function StatusIcon({
  status,
  className,
}: {
  status: TaskStatus;
  className?: string;
}) {
  const Icon = statusIcons[status];
  return (
    <Icon
      aria-hidden="true"
      weight={status === "done" ? "fill" : "regular"}
      className={cn("size-4 shrink-0 text-muted-foreground", className)}
    />
  );
}
