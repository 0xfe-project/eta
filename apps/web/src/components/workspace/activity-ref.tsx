import type { TaskStatus } from "@/queries/tasks";
import { AppWindowIcon } from "@phosphor-icons/react/AppWindow";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ROUTINES_VISIBLE } from "@/lib/features";
import { translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { actionClass, frameClass, framedClass, muted } from "./activity-card";
import { ArtifactButton } from "./artifact-dialog";
import { statuses } from "./task-format";
import { StatusIcon } from "./task-status-icon";
import { useSectionLink } from "./workspace-search";

/**
 * The card under a tool call that made or touched one thing (its block's
 * ref, which the tool's own result names): the whole card opens it, where
 * the rest of the app does. An artifact's card opens the version the tool
 * published in a dialog. The tool line above keeps the call's details.
 */
const kinds = {
  task: {
    icon: ListChecksIcon,
    get open() {
      return translate("common:actions.openTask");
    },
  },
  routine: {
    icon: ClockIcon,
    get open() {
      return translate("common:actions.openRoutine");
    },
  },
  artifact: {
    icon: AppWindowIcon,
    get open() {
      return translate("artifacts:actions.open");
    },
  },
} satisfies Record<ActivityRef["kind"], unknown>;

/** A thing a tool call made or touched, as its card names it. */
export interface ActivityRef {
  kind: "task" | "routine" | "artifact";
  title: string;
  /** The task's, routine's or artifact's id. */
  id?: string;
  /** The task's number, or the artifact's version. */
  number?: number;
  /** The task's status as the tool left it. */
  status?: string;
}

const iconClass = cn("size-3.5 shrink-0", muted);

const taskStatus = (status: string | undefined) =>
  statuses.find((s) => s.value === status);

export function ActivityRefCard({
  value,
  variant = "flat",
  className,
}: {
  value: ActivityRef;
  /** `flat` is a row of a list, which draws the rules; `framed` stands alone, in a chat. */
  variant?: "flat" | "framed";
  className?: string;
}) {
  const { t: translateText } = useTranslation(["common", "artifacts"] as const);
  const sectionLink = useSectionLink();
  // A routine's card is the way to its page; with routines off there is no page to open, so the
  // result of a call that touched one draws nothing rather than a dead link.
  if (!ROUTINES_VISIBLE && value.kind === "routine") return null;
  const { icon: Icon, open } = kinds[value.kind];
  const status = value.kind === "task" ? taskStatus(value.status) : undefined;
  const frame = cn(frameClass, variant === "framed" && framedClass);
  // An artifact's number is its version, not an id to show first.
  const artifact = value.kind === "artifact";
  const number = value.number && !artifact ? value.number : undefined;
  const label = [
    open,
    number ? `#${number}` : null,
    value.title,
    artifact && value.number
      ? translateText("artifacts:version.label", { version: value.number })
      : null,
  ]
    .filter(Boolean)
    .join(" ");
  const body = (
    <>
      <Icon aria-hidden="true" className={cn("size-4 shrink-0", muted)} />
      <span className="min-w-0 flex-1 truncate">
        {number ? (
          <span className={cn("tabular-nums", muted)}>#{number} </span>
        ) : null}
        <span className="text-foreground">{value.title}</span>
        {artifact && value.number ? (
          <span className={cn("tabular-nums", muted)}>
            {translateText("artifacts:version.inlineLabel", {
              version: value.number,
            })}
          </span>
        ) : null}
      </span>
      {status ? (
        <span className={cn("flex shrink-0 items-center gap-1", muted)}>
          <StatusIcon
            status={status.value as TaskStatus}
            className={iconClass}
          />
          {status.label}
        </span>
      ) : null}
      <CaretRightIcon aria-hidden="true" className={iconClass} />
    </>
  );

  if (!value.id) return null;
  if (artifact)
    return (
      <div className={cn(frame, className)}>
        <ArtifactButton
          id={value.id}
          version={value.number}
          aria-label={label}
          title={label}
          className={cn(actionClass, "flex-1")}
        >
          {body}
        </ArtifactButton>
      </div>
    );
  const link =
    value.kind === "task"
      ? sectionLink("tasks", { task: value.id })
      : sectionLink("routines", { routine: value.id });
  return (
    <Link
      {...link}
      aria-label={label}
      title={label}
      className={cn(frame, actionClass, className)}
    >
      {body}
    </Link>
  );
}
