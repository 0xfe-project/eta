import type { ActivityRef } from "@/api/control-plane.gen";
import type { TaskStatus } from "@/queries/tasks";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { statuses } from "./task-format";
import { StatusIcon } from "./task-status-icon";
import { useSectionLink } from "./workspace-search";

/**
 * The card under a tool call that made or touched one thing (its block's
 * ref, which the tool's own result names): the whole card opens it, where
 * the rest of the app does. The tool line above keeps the call's details.
 */
const kinds = {
  task: { icon: ListChecksIcon, open: "打开任务" },
  routine: { icon: ClockIcon, open: "打开定时" },
  pull_request: { icon: GitPullRequestIcon, open: "打开 PR" },
} satisfies Record<ActivityRef["kind"], unknown>;

const cardClass =
  "flex min-h-11 max-w-md items-center gap-2 border border-[var(--terminal-muted)]/40 px-2 py-1 text-left outline-none transition-colors duration-[60ms] ease-linear hover:bg-[var(--terminal-muted)]/10 focus-visible:ring-1 focus-visible:ring-[var(--terminal-link)]/60 motion-reduce:transition-none sm:min-h-8";

const taskStatus = (status: string | undefined) =>
  statuses.find((s) => s.value === status);

/** "owner/name" of a GitHub pull request's URL. */
function repository(url: string) {
  if (!URL.canParse(url)) return undefined;
  const [, owner, name] = new URL(url).pathname.split("/");
  return owner && name ? `${owner}/${name}` : undefined;
}

export function ActivityRefCard({
  value,
  className,
}: {
  value: ActivityRef;
  className?: string;
}) {
  const sectionLink = useSectionLink();
  const { icon: Icon, open } = kinds[value.kind];
  const status = value.kind === "task" ? taskStatus(value.status) : undefined;
  const repo =
    value.kind === "pull_request" && value.url
      ? repository(value.url)
      : undefined;
  const name = [
    value.number ? `#${value.number}` : null,
    value.title || repo,
  ].filter(Boolean);
  const body = (
    <>
      <Icon
        aria-hidden="true"
        className="size-4 shrink-0 text-[var(--terminal-muted)]"
      />
      <span className="min-w-0 flex-1 truncate">
        {value.number ? (
          <span className="tabular-nums text-[var(--terminal-muted)]">
            #{value.number}{" "}
          </span>
        ) : null}
        <span className="text-[var(--terminal-foreground)]">
          {value.title || repo}
        </span>
        {value.title && repo ? (
          <span className="text-[var(--terminal-muted)]"> · {repo}</span>
        ) : null}
      </span>
      {status ? (
        <span className="flex shrink-0 items-center gap-1 text-[var(--terminal-muted)]">
          <StatusIcon
            status={status.value as TaskStatus}
            className="size-3.5 text-[var(--terminal-muted)]"
          />
          {status.label}
        </span>
      ) : null}
      {value.url ? (
        <ArrowSquareOutIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-[var(--terminal-muted)]"
        />
      ) : (
        <CaretRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-[var(--terminal-muted)]"
        />
      )}
    </>
  );
  const label = [open, ...name].join(" ");

  if (value.kind === "pull_request") {
    return value.url ? (
      <a
        href={value.url}
        target="_blank"
        rel="noreferrer"
        aria-label={label}
        title={label}
        className={cn(cardClass, className)}
      >
        {body}
      </a>
    ) : null;
  }
  if (!value.id) return null;
  const link =
    value.kind === "task"
      ? sectionLink("tasks", { task: value.id })
      : sectionLink("routines", { routine: value.id });
  return (
    <Link
      {...link}
      aria-label={label}
      title={label}
      className={cn(cardClass, className)}
    >
      {body}
    </Link>
  );
}
